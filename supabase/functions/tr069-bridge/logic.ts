// Pure TR-069 rules (unit-tested from src/test). No network, no database. Never logs values.

export type Profile = {
  id: string; organization_id: string; validated: boolean; pilot_device_id?: string | null;
  manufacturer: string | null; product_class: string | null; model_name: string | null; firmware_prefix: string | null;
  wifi_2g_ssid_path: string | null; wifi_2g_password_path: string | null;
  wifi_5g_ssid_path: string | null; wifi_5g_password_path: string | null;
  allow_reboot: boolean;
};
export type DeviceLike = {
  id?: string; organization_id: string; acs_server_id: string; authorized: boolean;
  manufacturer: string | null; product_class: string | null; model_name: string | null; software_version: string | null;
};
export type TaskStatus = "requested" | "queued" | "unknown" | "unconfirmed" | "completed" | "failed";
export type Band = "2g" | "5g";

const eq = (rule: string | null, val: string | null) => !rule || (val ?? "").toLowerCase() === rule.toLowerCase();
const matches = (p: Profile, d: DeviceLike) =>
  p.organization_id === d.organization_id && !!(p.manufacturer || p.product_class || p.model_name) &&
  eq(p.manufacturer, d.manufacturer) && eq(p.product_class, d.product_class) && eq(p.model_name, d.model_name) &&
  (!p.firmware_prefix || (d.software_version ?? "").startsWith(p.firmware_prefix));

/** Validated profile, or an unvalidated one only for its single pilot device. Most specific wins. */
export function matchProfile(dev: DeviceLike, profiles: Profile[]): Profile | null {
  const ok = profiles.filter((p) => matches(p, dev) && (p.validated || (!!dev.id && p.pilot_device_id === dev.id)));
  const score = (p: Profile) => [p.manufacturer, p.product_class, p.model_name, p.firmware_prefix].filter(Boolean).length + (p.validated ? 0 : 10);
  return ok.sort((a, b) => score(b) - score(a))[0] ?? null;
}
/** Any same-org profile matching the model (validated or not): used only to DISPLAY values, flagged accordingly. */
export function displayProfile(dev: DeviceLike, profiles: Profile[]): Profile | null {
  return profiles.filter((p) => matches(p, dev)).sort((a, b) => Number(b.validated) - Number(a.validated))[0] ?? null;
}

export function sameTenant(dev: DeviceLike, server: { id: string; organization_id: string | null }, userOrgs: string[]): boolean {
  return !!server.organization_id && dev.acs_server_id === server.id && dev.organization_id === server.organization_id &&
    userOrgs.includes(server.organization_id);
}

/** Production requires HTTPS. Plain HTTP only with an explicit per-server lab flag (default off). */
export function nbiUrlAllowed(url: string, allowInsecureHttp: boolean): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: "URL inválida" }; }
  if (u.username || u.password) return { ok: false, reason: "Não coloque usuário/senha na URL" };
  if (u.protocol === "https:") return { ok: true };
  if (u.protocol === "http:" && allowInsecureHttp) return { ok: true };
  return { ok: false, reason: "A API do ACS precisa usar HTTPS (HTTP só com exceção de laboratório ativada)" };
}

export type CommandCheck = { ok: true } | { ok: false; reason: string };
export function canCommand(dev: DeviceLike, profile: Profile | null, kind: "wifi_2g" | "wifi_5g" | "reboot", wants?: { ssid?: boolean; password?: boolean }): CommandCheck {
  if (!dev.authorized) return { ok: false, reason: "Equipamento não aprovado" };
  if (!profile) return { ok: false, reason: "Sem perfil validado (ou piloto) para este modelo/firmware" };
  if (kind === "reboot") return profile.allow_reboot ? { ok: true } : { ok: false, reason: "Reinício não habilitado neste perfil" };
  const b = kind === "wifi_2g" ? "2g" : "5g";
  const l = b === "2g" ? "2,4" : "5";
  if (wants?.ssid && !profile[`wifi_${b}_ssid_path`]) return { ok: false, reason: `Perfil sem suporte a SSID ${l} GHz` };
  if (wants?.password && !profile[`wifi_${b}_password_path`]) return { ok: false, reason: `Perfil sem suporte a senha ${l} GHz` };
  return { ok: true };
}

/** Paths frozen into the task at request time; reconciliation never re-reads the (possibly edited) profile. */
export type Snapshot = { profile_id: string; validated: boolean; pilot: boolean; band?: Band; ssid_path?: string | null; password_path?: string | null };
export function snapshotFor(profile: Profile, band?: Band, devId?: string): Snapshot {
  return { profile_id: profile.id, validated: profile.validated, pilot: !profile.validated && profile.pilot_device_id === devId,
    ...(band ? { band, ssid_path: profile[`wifi_${band}_ssid_path`], password_path: profile[`wifi_${band}_password_path`] } : {}) };
}
export function wifiParams(s: Snapshot, ssid?: string, password?: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  if (ssid && s.ssid_path) out.push([s.ssid_path, ssid, "xsd:string"]);
  if (password && s.password_path) out.push([s.password_path, password, "xsd:string"]);
  return out;
}

/** Submit outcome. A timeout/network error AFTER sending may have been accepted: unknown, never failed. */
export function afterSubmit(r: number | "timeout"): TaskStatus {
  if (r === "timeout") return "unknown";
  if (r === 200) return "unconfirmed";
  if (r === 202) return "queued";
  if (r >= 500) return "unknown";
  return "failed";
}

export type Observed = { value: unknown; timestamp: string | null } | null;
/** Confirmation needs a value observed AFTER the request. Cached/older/identical-prior values never confirm. Passwords are write-only. */
export function confirmWifi(expectedSsid: string | null, observed: Observed, requestedAt: string, passwordChanged: boolean): { status: TaskStatus; confirmation: string; observed_at: string | null } {
  const ts = observed?.timestamp ?? null;
  const fresh = !!ts && Date.parse(ts) > Date.parse(requestedAt);
  if (expectedSsid) {
    if (!fresh) return { status: "unconfirmed", confirmation: "Sem leitura posterior ao comando", observed_at: ts };
    if (observed!.value !== expectedSsid) return { status: "unconfirmed", confirmation: "SSID lido após o comando difere do solicitado", observed_at: ts };
    if (passwordChanged) return { status: "unconfirmed", confirmation: "SSID confirmado; senha é somente escrita (não verificável)", observed_at: ts };
    return { status: "completed", confirmation: "SSID confirmado por leitura posterior", observed_at: ts };
  }
  return { status: "unconfirmed", confirmation: "Senha é somente escrita (não verificável)", observed_at: ts };
}

/** Reconcile a queued/unknown task. Any failed lookup keeps the task open: absence of evidence is not success. */
export function reconcileStep(i: { tasksOk: boolean; stillQueued: boolean; faultsOk: boolean; faultCount: number }): "keep" | "failed" | "applied" {
  if (!i.tasksOk || i.stillQueued) return "keep";
  if (!i.faultsOk) return "keep";
  return i.faultCount > 0 ? "failed" : "applied";
}

/** Resumable sync paging within a time budget. Never reports complete while items may remain. */
export function syncStep(cursor: number, pageLen: number, pageSize: number, elapsedMs: number, budgetMs: number) {
  const next = cursor + pageLen;
  const done = pageLen < pageSize;
  return { cursor: done ? 0 : next, complete: done, stop: done || elapsedMs >= budgetMs };
}

/** GenieACS parameter accessor returning value + observation timestamp. */
// deno-lint-ignore no-explicit-any
export function param(d: any, path: string | null | undefined): Observed {
  if (!path) return null;
  let cur = d;
  for (const p of path.split(".")) { if (cur == null) return null; cur = cur[p]; }
  return cur && typeof cur === "object" && "_value" in cur ? { value: cur._value, timestamp: cur._timestamp ?? null } : null;
}

export function safeError(s: unknown): string {
  return String(s ?? "").replace(/https?:\/\/[^@\s/]+@/g, "http://***@").replace(/(Basic|Bearer)\s+\S+/gi, "$1 ***").slice(0, 300);
}

// AES-256-GCM with a key derived from a backend-only secret. Output: v1.<iv b64>.<ct b64>.
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey(secret: string) {
  if (!secret || secret.length < 32) throw new Error("ACS key missing");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", h, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(plain: string, secret: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await aesKey(secret), new TextEncoder().encode(plain));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}
export async function decryptSecret(blob: string, secret: string, aad: string): Promise<string> {
  const [v, iv, ct] = blob.split(".");
  if (v !== "v1") throw new Error("bad ciphertext");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: new TextEncoder().encode(aad) }, await aesKey(secret), unb64(ct));
  return new TextDecoder().decode(pt);
}
