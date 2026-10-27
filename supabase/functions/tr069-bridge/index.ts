// Bridge between NOC-ISP and a GenieACS NBI. Admin-only for writes; never contacts modems directly.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { z } from "npm:zod@3";

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
  z.object({
    action: z.literal("set_wifi"),
    device_id: z.string().uuid(),
    band: z.enum(["2g", "5g"]),
    ssid: z.string().trim().min(1).max(32).optional(),
    password: z.string().min(8).max(63).optional(),
  }).refine((v) => v.ssid || v.password, "Informe SSID ou senha"),
]);

const PROJ = [
  "_id", "_lastInform", "_deviceId", "_tags",
  "InternetGatewayDevice.DeviceInfo.SoftwareVersion", "InternetGatewayDevice.DeviceInfo.ModelName",
  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID",
  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress",
  "Device.DeviceInfo.SoftwareVersion", "Device.DeviceInfo.ModelName",
  "Device.WiFi.SSID.1.SSID", "Device.WiFi.SSID.2.SSID",
  "Device.PPP.Interface.1.Username", "Device.IP.Interface.1.IPv4Address.1.IPAddress",
].join(",");

// deno-lint-ignore no-explicit-any
const v = (d: any, path: string) => {
  let cur = d;
  for (const p of path.split(".")) { if (cur == null) return null; cur = cur[p]; }
  return cur && typeof cur === "object" && "_value" in cur ? cur._value : null;
};

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

export function wifiParams(model: string, band: "2g" | "5g", ssid?: string, password?: string) {
  const out: [string, string, string][] = [];
  if (model === "tr181") {
    const i = band === "2g" ? 1 : 2;
    if (ssid) out.push([`Device.WiFi.SSID.${i}.SSID`, ssid, "xsd:string"]);
    if (password) out.push([`Device.WiFi.AccessPoint.${i}.Security.KeyPassphrase`, password, "xsd:string"]);
  } else {
    const i = band === "2g" ? 1 : 5;
    const b = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${i}`;
    if (ssid) out.push([`${b}.SSID`, ssid, "xsd:string"]);
    if (password) out.push([`${b}.PreSharedKey.1.KeyPassphrase`, password, "xsd:string"]);
  }
  return out;
}

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

    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
    const b = parsed.data;
    if (b.action !== "task_status" && !isAdmin) return json({ error: "admin required" }, 403);

    // Resolve server (and device) through the user's RLS client so tenant isolation is enforced.
    let device: Record<string, unknown> | null = null;
    let serverId: string;
    if ("device_id" in b) {
      const { data } = await userClient.from("tr069_devices").select("*").eq("id", b.device_id).maybeSingle();
      if (!data) return json({ error: "device not found" }, 404);
      device = data; serverId = data.acs_server_id;
    } else serverId = b.server_id;
    const { data: srv } = await userClient.from("acs_servers").select("id,organization_id,nbi_url,username,enabled").eq("id", serverId).maybeSingle();
    if (!srv) return json({ error: "acs not found" }, 404);
    const { data: pwd } = await admin.rpc("get_acs_password", { _id: srv.id });
    const base = String(srv.nbi_url).replace(/\/+$/, "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (srv.username) headers.Authorization = "Basic " + btoa(`${srv.username}:${pwd ?? ""}`);
    const nbi = (path: string, init: RequestInit = {}) =>
      fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(15000) });

    if (b.action === "test") {
      try {
        const r = await nbi("/devices?projection=_id&limit=1");
        const err = r.ok ? null : `HTTP ${r.status}`;
        await admin.from("acs_servers").update({ last_check_at: new Date().toISOString(), last_error: err }).eq("id", srv.id);
        return json({ ok: r.ok, error: err });
      } catch (e) {
        const err = String((e as Error).message);
        await admin.from("acs_servers").update({ last_check_at: new Date().toISOString(), last_error: err }).eq("id", srv.id);
        return json({ ok: false, error: err });
      }
    }

    if (b.action === "sync") {
      let skip = 0, total = 0;
      for (;;) {
        const r = await nbi(`/devices?projection=${PROJ}&limit=200&skip=${skip}`);
        if (!r.ok) return json({ ok: false, error: `ACS HTTP ${r.status}`, synced: total });
        const list = await r.json();
        if (!Array.isArray(list) || !list.length) break;
        const rows = list.map((d) => ({ ...mapDevice(d), acs_server_id: srv.id, organization_id: srv.organization_id, synced_at: new Date().toISOString() }));
        const { error } = await admin.from("tr069_devices").upsert(rows, { onConflict: "acs_server_id,genie_id" });
        if (error) return json({ ok: false, error: error.message, synced: total });
        total += rows.length; skip += list.length;
        if (list.length < 200 || total >= 10000) break;
      }
      await admin.from("acs_servers").update({ last_check_at: new Date().toISOString(), last_error: null }).eq("id", srv.id);
      return json({ ok: true, synced: total });
    }

    const gid = String(device!.genie_id);
    const q = encodeURIComponent(JSON.stringify({ _id: gid }));

    if (b.action === "refresh") {
      const r = await nbi(`/devices?query=${q}&projection=${PROJ}`);
      if (!r.ok) return json({ ok: false, error: `ACS HTTP ${r.status}` });
      const [d] = await r.json();
      if (!d) return json({ ok: false, error: "Equipamento não existe mais no ACS" });
      await admin.from("tr069_devices").update({ ...mapDevice(d), synced_at: new Date().toISOString() }).eq("id", device!.id as string);
      return json({ ok: true });
    }

    if (b.action === "set_wifi") {
      if (!device!.authorized) return json({ error: "Equipamento não autorizado" }, 400);
      const model = (device!.params as { data_model?: string })?.data_model ?? "tr098";
      const pv = wifiParams(model, b.band, b.ssid, b.password);
      const { data: task, error } = await admin.from("tr069_tasks").insert({
        organization_id: device!.organization_id, device_id: device!.id, task_type: "set_wifi",
        payload: { band: b.band, ssid: b.ssid ?? null, password_changed: !!b.password }, requested_by: uid,
      }).select("id").single();
      if (error) return json({ error: error.message }, 500);
      const r = await nbi(`/devices/${encodeURIComponent(gid)}/tasks?timeout=3000&connection_request`, {
        method: "POST", body: JSON.stringify({ name: "setParameterValues", parameterValues: pv }),
      });
      let status = "failed", gtask: string | null = null, err: string | null = null;
      if (r.status === 200) status = "completed";
      else if (r.status === 202) { status = "queued"; err = "Connection Request não alcançado: aplica na próxima sessão do equipamento"; }
      else err = `ACS HTTP ${r.status}`;
      try { gtask = (await r.json())?._id ?? null; } catch { /* empty body */ }
      await admin.from("tr069_tasks").update({ status, genie_task_id: gtask, error: err, completed_at: status === "completed" ? new Date().toISOString() : null }).eq("id", task.id);
      return json({ ok: status !== "failed", status, message: err });
    }

    // task_status: reconcile queued tasks with ACS (GenieACS deletes tasks once applied).
    const { data: pend } = await admin.from("tr069_tasks").select("id,genie_task_id").eq("device_id", device!.id as string).eq("status", "queued");
    for (const t of pend ?? []) {
      if (!t.genie_task_id) continue;
      const tq = encodeURIComponent(JSON.stringify({ _id: t.genie_task_id }));
      const r = await nbi(`/tasks?query=${tq}`);
      if (!r.ok) continue;
      const left = await r.json();
      if (Array.isArray(left) && left.length === 0) {
        const fr = await nbi(`/faults?query=${encodeURIComponent(JSON.stringify({ _id: `${gid}:task_${t.genie_task_id}` }))}`);
        const faults = fr.ok ? await fr.json() : [];
        await admin.from("tr069_tasks").update(faults.length
          ? { status: "failed", error: JSON.stringify(faults[0]?.detail ?? faults[0]?.code ?? "fault").slice(0, 500) }
          : { status: "completed", completed_at: new Date().toISOString(), error: null }).eq("id", t.id);
      }
    }
    return json({ ok: true });
  } catch (e) {
    console.error("tr069-bridge", e);
    return json({ error: String((e as Error).message) }, 500);
  }
});
