// Bridge between NOC-ISP and a GenieACS NBI. Admin-only for writes; never contacts modems directly.
// Every read/action re-checks organization in code (in addition to RLS). Secrets never leave this function.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3";
import { afterSubmit, canCommand, confirmWifi, idempotencyKey, matchProfile, safeError, sameTenant, wifiParams, type Profile, type DeviceLike } from "./logic.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test"), server_id: z.string().uuid() }),
  z.object({ action: z.literal("sync"), server_id: z.string().uuid() }),
  z.object({ action: z.literal("refresh"), device_id: z.string().uuid() }),
  z.object({ action: z.literal("task_status"), device_id: z.string().uuid() }),
  z.object({ action: z.literal("approve"), device_id: z.string().uuid(), authorized: z.boolean() }),
  z.object({ action: z.literal("reboot"), device_id: z.string().uuid(), confirm: z.literal(true) }),
  z.object({
    action: z.literal("set_wifi"),
    device_id: z.string().uuid(),
    band: z.enum(["2g", "5g"]),
    ssid: z.string().trim().min(1).max(32).optional(),
    password: z.string().min(8).max(63).optional(),
  }).refine((v) => v.ssid || v.password, "Informe SSID ou senha"),
]);

const BASE_PROJ = [
  "_id", "_lastInform", "_deviceId", "_tags",
  "InternetGatewayDevice.DeviceInfo.SoftwareVersion", "InternetGatewayDevice.DeviceInfo.ModelName",
  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID",
  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress",
  "Device.DeviceInfo.SoftwareVersion", "Device.DeviceInfo.ModelName",
  "Device.WiFi.SSID.1.SSID", "Device.WiFi.SSID.2.SSID",
  "Device.PPP.Interface.1.Username", "Device.IP.Interface.1.IPv4Address.1.IPAddress",
];
const PROJ = BASE_PROJ.join(",");

// deno-lint-ignore no-explicit-any
const v = (d: any, path: string) => {
  let cur = d;
  for (const p of path.split(".")) { if (cur == null) return null; cur = cur[p]; }
  return cur && typeof cur === "object" && "_value" in cur ? cur._value : null;
};

// Display-only mapping (read). Writes use the validated profile paths, never these guesses.
// deno-lint-ignore no-explicit-any
const mapDevice = (d: any) => {
  const tr181 = !!d.Device;
  return {
    genie_id: d._id as string,
    serial_number: d._deviceId?._SerialNumber ?? null,
    manufacturer: d._deviceId?._Manufacturer ?? null,
    oui: d._deviceId?._OUI ?? null,
    product_class: d._deviceId?._ProductClass ?? null,
    model_name: v(d, tr181 ? "Device.DeviceInfo.ModelName" : "InternetGatewayDevice.DeviceInfo.ModelName"),
    software_version: v(d, tr181 ? "Device.DeviceInfo.SoftwareVersion" : "InternetGatewayDevice.DeviceInfo.SoftwareVersion"),
    wifi_ssid: v(d, tr181 ? "Device.WiFi.SSID.1.SSID" : "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID"),
    wifi_ssid_5g: v(d, tr181 ? "Device.WiFi.SSID.2.SSID" : "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID"),
    pppoe_username: v(d, tr181 ? "Device.PPP.Interface.1.Username" : "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username"),
    ip_address: v(d, tr181 ? "Device.IP.Interface.1.IPv4Address.1.IPAddress" : "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress"),
    last_inform_at: d._lastInform ?? null,
    params: { data_model: tr181 ? "tr181" : "tr098", tags: d._tags ?? [] },
  };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const userClient = createClient(URL_, ANON, { global: { headers: { Authorization: auth } } });
    const { data: claims } = await userClient.auth.getClaims(auth.replace("Bearer ", ""));
    const uid = claims?.claims?.sub;
    if (!uid) return json({ error: "unauthorized" }, 401);
    const admin = createClient(URL_, SRK);
    const { data: authorized } = await admin.rpc("is_authorized", { _user_id: uid });
    if (!authorized) return json({ error: "forbidden" }, 403);
    const { data: isAdmin } = await admin.rpc("has_role", { _user_id: uid, _role: "admin" });
    const { data: mem } = await admin.from("organization_members").select("organization_id").eq("user_id", uid);
    const userOrgs = (mem ?? []).map((m) => m.organization_id as string);

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const b = parsed.data;
    if (b.action !== "task_status" && !isAdmin) return json({ error: "admin required" }, 403);

    // Resolve via RLS client, then re-check tenant in code.
    // deno-lint-ignore no-explicit-any
    let device: any = null;
    let serverId: string;
    if ("device_id" in b) {
      const { data } = await userClient.from("tr069_devices").select("*").eq("id", b.device_id).maybeSingle();
      if (!data) return json({ error: "device not found" }, 404);
      device = data; serverId = data.acs_server_id;
    } else serverId = b.server_id;
    const { data: srv } = await userClient.from("acs_servers").select("id,organization_id,nbi_url,username,enabled").eq("id", serverId).maybeSingle();
    if (!srv || !srv.organization_id || !userOrgs.includes(srv.organization_id)) return json({ error: "acs not found" }, 404);
    if (device && !sameTenant(device as DeviceLike, srv, userOrgs)) return json({ error: "device not found" }, 404);
    if (!srv.enabled && b.action !== "task_status") return json({ error: "ACS desativado" }, 400);

    if (b.action === "approve") {
      const { error } = await admin.from("tr069_devices").update({ authorized: b.authorized, approved_by: b.authorized ? uid : null, approved_at: b.authorized ? new Date().toISOString() : null })
        .eq("id", device.id).eq("organization_id", srv.organization_id);
      return error ? json({ error: safeError(error.message) }, 500) : json({ ok: true });
    }

    const { data: pwd } = await admin.rpc("get_acs_password", { _id: srv.id });
    const base = String(srv.nbi_url).replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (srv.username) headers.Authorization = "Basic " + btoa(`${srv.username}:${pwd ?? ""}`);
    const nbi = (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(15000) });

    if (b.action === "test") {
      let err: string | null = null, ok = false;
      try { const r = await nbi("/devices?projection=_id&limit=1"); ok = r.ok; err = r.ok ? null : `HTTP ${r.status}`; await r.body?.cancel(); }
      catch (e) { err = safeError((e as Error).message); }
      await admin.from("acs_servers").update({ last_check_at: new Date().toISOString(), last_error: err }).eq("id", srv.id);
      return json({ ok, error: err });
    }

    if (b.action === "sync") {
      let skip = 0, total = 0;
      for (;;) {
        const r = await nbi(`/devices?projection=${PROJ}&limit=200&skip=${skip}`);
        if (!r.ok) return json({ ok: false, error: `ACS HTTP ${r.status}`, synced: total });
        const list = await r.json();
        if (!Array.isArray(list) || !list.length) break;
        // New devices arrive unapproved (column default); upsert never touches `authorized`.
        const rows = list.map((d) => ({ ...mapDevice(d), acs_server_id: srv.id, organization_id: srv.organization_id, synced_at: new Date().toISOString() }));
        const { error } = await admin.from("tr069_devices").upsert(rows, { onConflict: "acs_server_id,genie_id" });
        if (error) return json({ ok: false, error: safeError(error.message), synced: total });
        total += rows.length; skip += list.length;
        if (list.length < 200 || total >= 10000) break;
      }
      await admin.from("acs_servers").update({ last_check_at: new Date().toISOString(), last_error: null }).eq("id", srv.id);
      return json({ ok: true, synced: total });
    }

    const gid = String(device.genie_id);
    const q = encodeURIComponent(JSON.stringify({ _id: gid }));
    const { data: profs } = await admin.from("tr069_profiles").select("*").eq("organization_id", srv.organization_id);
    const profile = matchProfile(device as DeviceLike, (profs ?? []) as Profile[]);

    // Reads current values (base + profile paths) and stores display fields. Returns raw doc.
    const readDevice = async () => {
      const extra = profile ? [profile.wifi_2g_ssid_path, profile.wifi_5g_ssid_path].filter(Boolean) : [];
      const r = await nbi(`/devices?query=${q}&projection=${[...BASE_PROJ, ...extra].join(",")}`);
      if (!r.ok) { await r.body?.cancel(); return null; }
      const [d] = await r.json();
      if (!d) return null;
      await admin.from("tr069_devices").update({ ...mapDevice(d), synced_at: new Date().toISOString() }).eq("id", device.id);
      return d;
    };

    if (b.action === "refresh") {
      const d = await readDevice();
      return d ? json({ ok: true }) : json({ ok: false, error: "Equipamento não encontrado no ACS" });
    }

    if (b.action === "set_wifi" || b.action === "reboot") {
      const kind = b.action === "reboot" ? "reboot" : (b.band === "2g" ? "wifi_2g" : "wifi_5g");
      const chk = canCommand(device as DeviceLike, profile, kind, b.action === "set_wifi" ? { ssid: !!b.ssid, password: !!b.password } : undefined);
      if (!chk.ok) return json({ error: chk.reason }, 400);
      const ssid = b.action === "set_wifi" ? b.ssid ?? null : null;
      const pwChanged = b.action === "set_wifi" && !!b.password;
      const key = await idempotencyKey(device.id, kind, ssid, pwChanged);
      const { data: task, error } = await admin.from("tr069_tasks").insert({
        organization_id: srv.organization_id, acs_server_id: srv.id, device_id: device.id, task_type: b.action,
        payload: b.action === "set_wifi" ? { band: b.band, ssid, password_changed: pwChanged } : {},
        requested_by: uid, status: "requested", idempotency_key: key, profile_id: profile!.id,
      }).select("id").single();
      if (error) {
        if (error.code === "23505") return json({ ok: false, duplicate: true, message: "Já existe uma tarefa igual ou pendente para este equipamento" }, 409);
        return json({ error: safeError(error.message) }, 500);
      }
      const body = b.action === "reboot" ? { name: "reboot" } : { name: "setParameterValues", parameterValues: wifiParams(profile!, b.band, b.ssid, b.password) };
      let r: Response;
      try {
        r = await nbi(`/devices/${encodeURIComponent(gid)}/tasks?timeout=3000&connection_request`, { method: "POST", body: JSON.stringify(body) });
      } catch (e) {
        await admin.from("tr069_tasks").update({ status: "failed", error: safeError((e as Error).message) }).eq("id", task.id);
        return json({ ok: false, status: "failed", message: "ACS inacessível" });
      }
      let status = afterSubmit(r.status), gtask: string | null = null, err: string | null = null, confirmation: string | null = null;
      try { gtask = (await r.json())?._id ?? null; } catch { /* empty body */ }
      if (status === "failed") err = `ACS HTTP ${r.status}`;
      if (status === "queued") confirmation = "Aguardando próxima sessão do equipamento";
      if (status === "unconfirmed") {
        if (b.action === "reboot") confirmation = "ACS aplicou; reinício confirmado só quando o equipamento voltar a informar";
        else {
          const d = await readDevice();
          const read = d && profile![`wifi_${b.band}_ssid_path`] ? v(d, profile![`wifi_${b.band}_ssid_path`]!) : null;
          ({ status, confirmation } = confirmWifi(ssid, read, pwChanged));
        }
      }
      await admin.from("tr069_tasks").update({ status, genie_task_id: gtask, error: err, confirmation, completed_at: status === "completed" ? new Date().toISOString() : null }).eq("id", task.id);
      return json({ ok: status !== "failed", status, message: err ?? confirmation });
    }

    // task_status: reconcile queued tasks (GenieACS deletes tasks once applied).
    const { data: pend } = await admin.from("tr069_tasks").select("id,genie_task_id,task_type,payload")
      .eq("device_id", device.id).eq("organization_id", srv.organization_id).eq("status", "queued");
    for (const t of pend ?? []) {
      if (!t.genie_task_id) continue;
      const r = await nbi(`/tasks?query=${encodeURIComponent(JSON.stringify({ _id: t.genie_task_id }))}`);
      if (!r.ok) { await r.body?.cancel(); continue; }
      const left = await r.json();
      if (!Array.isArray(left) || left.length) continue;
      const fr = await nbi(`/faults?query=${encodeURIComponent(JSON.stringify({ _id: `${gid}:task_${t.genie_task_id}` }))}`);
      const faults = fr.ok ? await fr.json() : [];
      if (faults.length) {
        await admin.from("tr069_tasks").update({ status: "failed", error: safeError(JSON.stringify(faults[0]?.code ?? "fault")) }).eq("id", t.id);
        continue;
      }
      // deno-lint-ignore no-explicit-any
      const p = t.payload as any;
      let res = { status: "unconfirmed", confirmation: "ACS aplicou; sem leitura de confirmação" };
      if (t.task_type === "set_wifi" && profile) {
        const d = await readDevice();
        const path = profile[`wifi_${p.band as "2g" | "5g"}_ssid_path`];
        res = confirmWifi(p.ssid ?? null, d && path ? v(d, path) : null, !!p.password_changed);
      }
      await admin.from("tr069_tasks").update({ ...res, error: null, completed_at: res.status === "completed" ? new Date().toISOString() : null }).eq("id", t.id);
    }
    return json({ ok: true });
  } catch (e) {
    console.error("tr069-bridge", safeError((e as Error).message));
    return json({ error: "Erro interno" }, 500);
  }
});
