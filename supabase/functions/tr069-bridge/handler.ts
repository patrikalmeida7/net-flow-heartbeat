// tr069-bridge request handler with injected dependencies (tested from src/test with in-memory fakes).
import { z } from "npm:zod@3";
import {
  afterSubmit, canCommand, confirmWifi, decryptSecret, displayProfile, encryptSecret, matchProfile, nbiUrlAllowed, param,
  reconcileStep, safeError, sameTenant, snapshotFor, syncStep, wifiParams, type Band, type DeviceLike, type Profile, type Snapshot,
} from "./logic.ts";

// deno-lint-ignore no-explicit-any
type Db = any;
export type Deps = {
  cors: Record<string, string>;
  getUid: (auth: string) => Promise<string | null>;
  userDb: (auth: string) => Db;      // RLS-scoped client
  admin: Db;                          // service role
  fetch: typeof fetch;
  secretKey: string;
  now?: () => number;
  syncBudgetMs?: number;
  pageSize?: number;
};

const id = z.string().uuid();
export const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test"), server_id: id }),
  z.object({ action: z.literal("sync"), server_id: id, restart: z.boolean().optional() }),
  z.object({ action: z.literal("set_password"), server_id: id, password: z.string().min(1).max(200) }),
  z.object({ action: z.literal("refresh"), device_id: id }),
  z.object({ action: z.literal("task_status"), device_id: id }),
  z.object({ action: z.literal("approve"), device_id: id, authorized: z.boolean() }),
  z.object({ action: z.literal("resolve_unknown"), device_id: id, task_id: id, outcome: z.enum(["failed", "unconfirmed"]) }),
  z.object({ action: z.literal("reboot"), device_id: id, request_id: id, confirm: z.literal(true) }),
  z.object({
    action: z.literal("set_wifi"), device_id: id, request_id: id, band: z.enum(["2g", "5g"]),
    ssid: z.string().trim().min(1).max(32).optional(), password: z.string().min(8).max(63).optional(),
  }),
]).superRefine((v, ctx) => {
  if (v.action === "set_wifi" && !v.ssid && !v.password) ctx.addIssue({ code: "custom", message: "Informe SSID ou senha" });
});

const BASE_PROJ = ["_id", "_lastInform", "_deviceId", "_tags",
  "InternetGatewayDevice.DeviceInfo.SoftwareVersion", "InternetGatewayDevice.DeviceInfo.ModelName",
  "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID", "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username",
  "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress",
  "Device.DeviceInfo.SoftwareVersion", "Device.DeviceInfo.ModelName", "Device.WiFi.SSID.1.SSID", "Device.WiFi.SSID.2.SSID",
  "Device.PPP.Interface.1.Username", "Device.IP.Interface.1.IPv4Address.1.IPAddress"];
const val = (d: unknown, p: string) => (param(d, p)?.value ?? null) as string | null;

// Identity fields + display values. SSID comes from a matching profile's paths when available; otherwise flagged as a guess.
// deno-lint-ignore no-explicit-any
export function mapDevice(d: any, profiles: Profile[], ctx: { organization_id: string; acs_server_id: string }) {
  const tr181 = !!d.Device;
  const base = {
    genie_id: String(d._id),
    serial_number: d._deviceId?._SerialNumber ?? null, manufacturer: d._deviceId?._Manufacturer ?? null,
    oui: d._deviceId?._OUI ?? null, product_class: d._deviceId?._ProductClass ?? null,
    model_name: val(d, tr181 ? "Device.DeviceInfo.ModelName" : "InternetGatewayDevice.DeviceInfo.ModelName"),
    software_version: val(d, tr181 ? "Device.DeviceInfo.SoftwareVersion" : "InternetGatewayDevice.DeviceInfo.SoftwareVersion"),
    pppoe_username: val(d, tr181 ? "Device.PPP.Interface.1.Username" : "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username"),
    ip_address: val(d, tr181 ? "Device.IP.Interface.1.IPv4Address.1.IPAddress" : "InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress"),
    last_inform_at: d._lastInform ?? null,
  };
  const prof = displayProfile({ ...base, ...ctx, authorized: false }, profiles);
  const wifi = prof
    ? { wifi_ssid: val(d, prof.wifi_2g_ssid_path ?? ""), wifi_ssid_5g: prof.wifi_5g_ssid_path ? val(d, prof.wifi_5g_ssid_path) : null, wifi_source: prof.validated ? "profile" : "profile_unvalidated" }
    : { wifi_ssid: val(d, tr181 ? "Device.WiFi.SSID.1.SSID" : "InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID"),
        wifi_ssid_5g: val(d, tr181 ? "Device.WiFi.SSID.2.SSID" : "InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID"), wifi_source: "guess" };
  const { wifi_source, ...w } = wifi;
  return { ...base, ...w, params: { data_model: tr181 ? "tr181" : "tr098", tags: d._tags ?? [], wifi_source } };
}

/**
 * Reads the ACS password. Legacy column is migrated without ever overwriting a newer password
 * (insert-if-absent), verified by re-reading and decrypting, and cleared only after that check.
 * Any failure keeps the legacy value in place, so the next request resumes idempotently. Values are never logged.
 */
export async function loadPassword(admin: Db, key: string, serverId: string, iso: () => string): Promise<{ ok: true; pwd: string | null } | { ok: false }> {
  const readStored = async () => {
    const { data, error } = await admin.from("acs_server_secrets").select("ciphertext").eq("server_id", serverId).maybeSingle();
    if (error) return { error: true as const };
    if (!data?.ciphertext) return { pwd: null };
    try { return { pwd: await decryptSecret(data.ciphertext, key, serverId) }; } catch { return { error: true as const }; }
  };
  const clearLegacy = async () => {
    const { error } = await admin.from("acs_servers").update({ password_encrypted: null }).eq("id", serverId);
    if (error) console.error("tr069-bridge: limpeza da senha antiga pendente");
  };
  const stored = await readStored();
  if ("error" in stored) return { ok: false };
  const { data: legacy, error: lErr } = await admin.rpc("get_acs_password", { _id: serverId });
  if (stored.pwd != null) {
    if (!lErr && legacy) await clearLegacy(); // resume an interrupted migration
    return { ok: true, pwd: stored.pwd };
  }
  if (lErr) return { ok: false };
  if (!legacy) return { ok: true, pwd: null };
  let ciphertext: string;
  try { ciphertext = await encryptSecret(legacy, key, serverId); } catch { return { ok: true, pwd: legacy }; }
  const { error: wErr } = await admin.from("acs_server_secrets")
    .upsert({ server_id: serverId, ciphertext, key_version: 1, updated_at: iso() }, { onConflict: "server_id", ignoreDuplicates: true });
  if (wErr) { console.error("tr069-bridge: migração da senha do ACS falhou; senha antiga preservada"); return { ok: true, pwd: legacy }; }
  const after = await readStored();
  if ("error" in after || after.pwd == null) return { ok: true, pwd: legacy }; // not confirmed: keep legacy
  await clearLegacy();
  return { ok: true, pwd: after.pwd }; // a concurrent set_password may have won: use the stored (newer) value
}

export function createHandler(deps: Deps) {
  const now = deps.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...deps.cors, "Content-Type": "application/json" } });
  const admin = deps.admin;

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: deps.cors });
    try {
      const auth = req.headers.get("Authorization") ?? "";
      const uid = await deps.getUid(auth);
      if (!uid) return json({ error: "unauthorized" }, 401);
      const { data: authorized } = await admin.rpc("is_authorized", { _user_id: uid });
      if (!authorized) return json({ error: "forbidden" }, 403);
      const { data: isAdmin } = await admin.rpc("has_role", { _user_id: uid, _role: "admin" });
      const { data: mem } = await admin.from("organization_members").select("organization_id").eq("user_id", uid);
      const userOrgs: string[] = (mem ?? []).map((m: { organization_id: string }) => m.organization_id);

      let raw: unknown;
      try { raw = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }
      const parsed = Body.safeParse(raw);
      if (!parsed.success) return json({ error: parsed.error.flatten() }, 400);
      const b = parsed.data;
      if (b.action !== "task_status" && !isAdmin) return json({ error: "admin required" }, 403);

      const userDb = deps.userDb(auth);
      // deno-lint-ignore no-explicit-any
      let device: any = null;
      let serverId: string;
      if ("device_id" in b) {
        const { data } = await userDb.from("tr069_devices").select("*").eq("id", b.device_id).maybeSingle();
        if (!data) return json({ error: "device not found" }, 404);
        device = data; serverId = data.acs_server_id;
      } else serverId = (b as { server_id: string }).server_id;
      const { data: srv } = await userDb.from("acs_servers").select("id,organization_id,nbi_url,username,enabled,allow_insecure_http,sync_cursor").eq("id", serverId).maybeSingle();
      if (!srv || !srv.organization_id || !userOrgs.includes(srv.organization_id)) return json({ error: "acs not found" }, 404);
      if (device && !sameTenant(device as DeviceLike, srv, userOrgs)) return json({ error: "device not found" }, 404);
      const org = srv.organization_id as string;
      const audit = (action: string, result: string, detail: Record<string, unknown> = {}) =>
        admin.from("tr069_audit").insert({ organization_id: org, acs_server_id: srv.id, device_id: device?.id ?? null, actor: uid, action, result, detail });

      if (b.action === "set_password") {
        const ciphertext = await encryptSecret(b.password, deps.secretKey, srv.id);
        const { error } = await admin.from("acs_server_secrets").upsert({ server_id: srv.id, ciphertext, key_version: 1, updated_at: iso() }, { onConflict: "server_id" });
        if (error) return json({ error: "Não foi possível salvar a senha" }, 500);
        // New store wins over the legacy column; a failed clear is retried on the next request.
        const { error: clr } = await admin.from("acs_servers").update({ password_encrypted: null }).eq("id", srv.id);
        if (clr) console.error("tr069-bridge: limpeza da senha antiga pendente");
        await audit("set_password", "ok");
        return json({ ok: true });
      }

      if (b.action === "approve") {
        const { error } = await admin.from("tr069_devices").update({ authorized: b.authorized, approved_by: b.authorized ? uid : null, approved_at: b.authorized ? iso() : null })
          .eq("id", device.id).eq("organization_id", org);
        await audit(b.authorized ? "approve" : "block", error ? "error" : "ok", { serial: device.serial_number ?? null });
        return error ? json({ error: safeError(error.message) }, 500) : json({ ok: true });
      }

      if (b.action === "resolve_unknown") {
        const { data: t } = await admin.from("tr069_tasks").select("id,status").eq("id", b.task_id).eq("device_id", device.id).eq("organization_id", org).maybeSingle();
        if (!t || !["unknown", "queued"].includes(t.status)) return json({ error: "Tarefa não está pendente" }, 400);
        await admin.from("tr069_tasks").update({ status: b.outcome, error: "Encerrada manualmente pelo administrador após conferência no ACS" }).eq("id", t.id);
        await audit("resolve_unknown", b.outcome, { task_id: t.id });
        return json({ ok: true });
      }

      if (!srv.enabled && b.action !== "task_status") return json({ error: "ACS desativado" }, 400);
      const urlOk = nbiUrlAllowed(String(srv.nbi_url), !!srv.allow_insecure_http);
      if (!urlOk.ok) return json({ error: (urlOk as { reason: string }).reason }, 400);

      // Credentials: new store, with resumable lazy migration from the deprecated column.
      const cred = await loadPassword(admin, deps.secretKey, srv.id, iso);
      if (!cred.ok) return json({ error: "Credencial do ACS indisponível" }, 500);
      const pwd = cred.pwd;
      const base = String(srv.nbi_url).replace(/\/+$/, "");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (srv.username) headers.Authorization = "Basic " + btoa(`${srv.username}:${pwd ?? ""}`);
      const nbi = (path: string, init: RequestInit = {}) => deps.fetch(base + path, { ...init, headers, signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(15000) : undefined });

      const { data: profs } = await admin.from("tr069_profiles").select("*").eq("organization_id", org);
      const profiles = (profs ?? []) as Profile[];

      if (b.action === "test") {
        let err: string | null = null, ok = false;
        try { const r = await nbi("/devices?projection=_id&limit=1"); ok = r.ok; err = r.ok ? null : `HTTP ${r.status}`; await r.body?.cancel(); }
        catch (e) { err = safeError((e as Error).message); }
        await admin.from("acs_servers").update({ last_check_at: iso(), last_error: err }).eq("id", srv.id);
        return json({ ok, error: err });
      }

      if (b.action === "sync") {
        const size = deps.pageSize ?? 200, budget = deps.syncBudgetMs ?? 20000, t0 = now();
        const extra = [...new Set(profiles.flatMap((p) => [p.wifi_2g_ssid_path, p.wifi_5g_ssid_path]).filter(Boolean))] as string[];
        const proj = [...BASE_PROJ, ...extra].join(",");
        let cursor = b.restart ? 0 : Number(srv.sync_cursor ?? 0), seen = 0;
        for (;;) {
          let list: unknown[];
          try {
            const r = await nbi(`/devices?projection=${encodeURIComponent(proj)}&sort=${encodeURIComponent('{"_id":1}')}&limit=${size}&skip=${cursor}`);
            if (!r.ok) throw new Error(`ACS HTTP ${r.status}`);
            list = await r.json();
            if (!Array.isArray(list)) throw new Error("resposta inválida");
          } catch (e) {
            await admin.from("acs_servers").update({ sync_cursor: cursor, sync_status: "partial", sync_updated_at: iso(), last_error: safeError((e as Error).message) }).eq("id", srv.id);
            return json({ ok: false, complete: false, synced: seen, cursor, error: safeError((e as Error).message) });
          }
          if (list.length) {
            // `authorized`/approval columns are never part of the upsert, so approvals survive syncs.
            const rows = list.map((d) => ({ ...mapDevice(d, profiles, { organization_id: org, acs_server_id: srv.id }), acs_server_id: srv.id, organization_id: org, synced_at: iso() }));
            const { error } = await admin.from("tr069_devices").upsert(rows, { onConflict: "acs_server_id,genie_id" });
            if (error) {
              await admin.from("acs_servers").update({ sync_cursor: cursor, sync_status: "partial", sync_updated_at: iso() }).eq("id", srv.id);
              return json({ ok: false, complete: false, synced: seen, cursor, error: safeError(error.message) });
            }
          }
          seen += list.length;
          const st = syncStep(cursor, list.length, size, now() - t0, budget);
          cursor = st.cursor;
          if (st.stop) {
            await admin.from("acs_servers").update({ sync_cursor: cursor, sync_status: st.complete ? "complete" : "partial", sync_updated_at: iso(), ...(st.complete ? { last_error: null, last_check_at: iso() } : {}) }).eq("id", srv.id);
            return json({ ok: true, complete: st.complete, synced: seen, cursor });
          }
        }
      }

      const gid = String(device.genie_id);
      const q = encodeURIComponent(JSON.stringify({ _id: gid }));
      const readDevice = async (paths: string[]) => {
        const r = await nbi(`/devices?query=${q}&projection=${encodeURIComponent([...BASE_PROJ, ...paths].join(","))}`);
        if (!r.ok) { await r.body?.cancel(); return null; }
        const [d] = await r.json();
        if (!d) return null;
        await admin.from("tr069_devices").update({ ...mapDevice(d, profiles, { organization_id: org, acs_server_id: srv.id }), synced_at: iso() }).eq("id", device.id);
        return d;
      };
      // Ask the CPE (via GenieACS) for a fresh value; only 200 means it was read in this session.
      const requestRead = async (path: string) => {
        try {
          const r = await nbi(`/devices/${encodeURIComponent(gid)}/tasks?timeout=3000&connection_request`, { method: "POST", body: JSON.stringify({ name: "getParameterValues", parameterNames: [path] }) });
          await r.body?.cancel();
          return r.status === 200;
        } catch { return false; }
      };

      if (b.action === "refresh") {
        const d = await readDevice([]);
        return d ? json({ ok: true }) : json({ ok: false, error: "Equipamento não encontrado no ACS" });
      }

      if (b.action === "set_wifi" || b.action === "reboot") {
        const band: Band | undefined = b.action === "set_wifi" ? b.band : undefined;
        const kind = b.action === "reboot" ? "reboot" : (band === "2g" ? "wifi_2g" : "wifi_5g");
        // Same request_id = same task: a retry returns the stored task instead of sending again.
        const { data: prev } = await admin.from("tr069_tasks").select("id,status,confirmation,error").eq("device_id", device.id).eq("request_id", b.request_id).maybeSingle();
        if (prev) return json({ ok: prev.status !== "failed", status: prev.status, message: prev.confirmation ?? prev.error, duplicate: true });
        const profile = matchProfile(device as DeviceLike, profiles);
        const chk = canCommand(device as DeviceLike, profile, kind, b.action === "set_wifi" ? { ssid: !!b.ssid, password: !!b.password } : undefined);
        if (!chk.ok) { const why = (chk as { reason: string }).reason; await audit(b.action, "blocked", { reason: why }); return json({ error: why }, 400); }
        const snap = snapshotFor(profile!, band, device.id);
        const ssid = b.action === "set_wifi" ? b.ssid ?? null : null;
        const pwChanged = b.action === "set_wifi" && !!b.password;
        const requestedAt = iso();
        // Persisted BEFORE sending. Unique (device, request_id) and one-open-per-type block concurrent duplicates.
        const { data: task, error } = await admin.from("tr069_tasks").insert({
          organization_id: org, acs_server_id: srv.id, device_id: device.id, task_type: b.action, request_id: b.request_id, requested_at: requestedAt,
          payload: band ? { band, ssid, password_changed: pwChanged } : {}, profile_snapshot: snap, profile_id: snap.profile_id,
          requested_by: uid, status: "requested",
        }).select("id").single();
        if (error) {
          if (error.code === "23505") return json({ ok: false, duplicate: true, message: "Já existe uma tarefa deste tipo em aberto para o equipamento" }, 409);
          return json({ error: safeError(error.message) }, 500);
        }
        const body = b.action === "reboot" ? { name: "reboot" } : { name: "setParameterValues", parameterValues: wifiParams(snap, b.ssid, b.password) };
        let res: number | "timeout"; let gtask: string | null = null;
        try {
          const r = await nbi(`/devices/${encodeURIComponent(gid)}/tasks?timeout=3000&connection_request`, { method: "POST", body: JSON.stringify(body) });
          res = r.status;
          try { gtask = (await r.json())?._id ?? null; } catch { /* empty */ }
        } catch { res = "timeout"; }
        let status = afterSubmit(res), err: string | null = null, confirmation: string | null = null, observed_at: string | null = null;
        if (status === "failed") err = `ACS HTTP ${res}`;
        if (status === "unknown") confirmation = "Resultado desconhecido: o ACS pode ter aceitado. Confira antes de repetir.";
        if (status === "queued") confirmation = "Aguardando próxima sessão do equipamento";
        if (status === "unconfirmed") {
          if (b.action === "reboot") confirmation = "ACS aplicou; reinício confirmado só quando o equipamento voltar a informar";
          else if (snap.ssid_path && ssid && await requestRead(snap.ssid_path)) {
            const d = await readDevice([snap.ssid_path]);
            ({ status, confirmation, observed_at } = confirmWifi(ssid, d ? param(d, snap.ssid_path) : null, requestedAt, pwChanged));
          } else ({ status, confirmation, observed_at } = confirmWifi(ssid, null, requestedAt, pwChanged));
        }
        await admin.from("tr069_tasks").update({ status, genie_task_id: gtask, error: err, confirmation, observed_at, completed_at: status === "completed" ? iso() : null }).eq("id", task.id);
        await audit(b.action, status, { task_id: task.id, band: band ?? null, ssid_changed: !!ssid, password_changed: pwChanged, pilot: snap.pilot });
        return json({ ok: status !== "failed", status, message: err ?? confirmation });
      }

      // task_status: reconcile using the task's frozen snapshot, never the current profile. Never resends the original command.
      const safeRead = async (paths: string[]) => { try { return await readDevice(paths); } catch { return null; } };
      // deno-lint-ignore no-explicit-any
      const checkUnconfirmed = async (t: any) => {
        const kind = verifiable(t);
        if (!kind) return; // write-only password: stays unconfirmed, no further reads
        const snap = t.profile_snapshot as Snapshot;
        // deno-lint-ignore no-explicit-any
        const p = (t.payload ?? {}) as any;
        const evaluate = (d: unknown) => {
          if (kind === "reboot") return d && rebootConfirmed((d as { _lastBoot?: unknown })._lastBoot, t.requested_at)
            ? { status: "completed" as const, confirmation: "Reinício confirmado por novo boot posterior à solicitação", observed_at: String((d as { _lastBoot: string })._lastBoot) } : null;
          const r = confirmWifi(p.ssid, d ? param(d, snap.ssid_path) : null, t.requested_at, !!p.password_changed);
          return r.observed_at && Date.parse(r.observed_at) > Date.parse(t.requested_at) && r.confirmation.startsWith("SSID confirmado") ? r : null;
        };
        const save = (r: { status: string; confirmation: string; observed_at: string | null }) =>
          admin.from("tr069_tasks").update({ ...r, error: null, completed_at: r.status === "completed" ? iso() : null }).eq("id", t.id);
        // 1) Passive read of what the ACS already holds (no CPE task).
        const ok1 = evaluate(await safeRead(kind === "ssid" ? [snap.ssid_path!] : []));
        if (ok1) { await save(ok1); return; }
        // 2) Reboot is never "read" from the CPE; SSID gets a bounded, tracked read request.
        if (kind === "reboot" || readPlan(t, now()) !== "request") return;
        const attempts = (t.read_attempts ?? 0) + 1;
        const { error: tErr } = await admin.from("tr069_tasks").update({ read_attempts: attempts, last_read_requested_at: iso() }).eq("id", t.id).eq("read_attempts", t.read_attempts ?? 0);
        if (tErr) return; // could not record the request: do not send it
        if (!(await requestRead(snap.ssid_path!))) return;
        const ok2 = evaluate(await safeRead([snap.ssid_path!]));
        if (ok2) await save(ok2);
      };
      const { data: pend, error: pErr } = await admin.from("tr069_tasks").select("id,genie_task_id,task_type,payload,profile_snapshot,requested_at,status,confirmation,read_attempts,last_read_requested_at")
        .eq("device_id", device.id).eq("organization_id", org).in("status", ["queued", "unknown", "unconfirmed"]);
      if (pErr) return json({ ok: false, error: "Não foi possível consultar as tarefas" }, 500);
      for (const t of pend ?? []) {
        if (t.status === "unconfirmed") { await checkUnconfirmed(t); continue; }
        let tasksOk = false, stillQueued = false;
        try {
          const tq = t.genie_task_id ? { _id: t.genie_task_id } : { device: gid };
          const r = await nbi(`/tasks?query=${encodeURIComponent(JSON.stringify(tq))}`);
          if (r.ok) { const left = await r.json(); tasksOk = Array.isArray(left); stillQueued = tasksOk && left.length > 0; } else await r.body?.cancel();
        } catch { /* keep */ }
        // Without the ACS task id we cannot tell whether our command ran: stays unknown for admin resolution.
        if (t.status === "unknown" && !t.genie_task_id) continue;
        let faultsOk = false, faultCount = 0, faultCode: unknown = null;
        if (tasksOk && !stillQueued) {
          try {
            const fr = await nbi(`/faults?query=${encodeURIComponent(JSON.stringify({ _id: `${gid}:task_${t.genie_task_id}` }))}`);
            if (fr.ok) { const f = await fr.json(); faultsOk = Array.isArray(f); faultCount = faultsOk ? f.length : 0; faultCode = f?.[0]?.code ?? null; } else await fr.body?.cancel();
          } catch { /* keep */ }
        }
        const step = reconcileStep({ tasksOk, stillQueued, faultsOk, faultCount });
        if (step === "keep") continue;
        if (step === "failed") { await admin.from("tr069_tasks").update({ status: "failed", error: safeError(JSON.stringify(faultCode ?? "fault")) }).eq("id", t.id); continue; }
        // deno-lint-ignore no-explicit-any
        const p = (t.payload ?? {}) as any;
        const base = t.task_type === "set_wifi" ? confirmWifi(p.ssid ?? null, null, t.requested_at, !!p.password_changed)
          : { status: "unconfirmed" as const, confirmation: "ACS aplicou; reinício confirmado só com novo boot posterior", observed_at: null };
        const { error: uErr } = await admin.from("tr069_tasks").update({ ...base, error: null, completed_at: null }).eq("id", t.id);
        if (!uErr) await checkUnconfirmed({ ...t, ...base, status: "unconfirmed" });
      }
      return json({ ok: true });
    } catch (e) {
      console.error("tr069-bridge", safeError((e as Error).message));
      return json({ error: "Erro interno" }, 500);
    }
  };
}
