// Pure TR-069 rules (unit-tested from src/test). No I/O, no secrets.

export type Profile = {
  id: string; organization_id: string; validated: boolean;
  manufacturer: string | null; product_class: string | null; model_name: string | null; firmware_prefix: string | null;
  wifi_2g_ssid_path: string | null; wifi_2g_password_path: string | null;
  wifi_5g_ssid_path: string | null; wifi_5g_password_path: string | null;
  allow_reboot: boolean;
};
export type DeviceLike = {
  organization_id: string; acs_server_id: string; authorized: boolean;
  manufacturer: string | null; product_class: string | null; model_name: string | null; software_version: string | null;
};
export type TaskStatus = "requested" | "queued" | "completed" | "failed" | "unconfirmed";

const eq = (rule: string | null, val: string | null) => !rule || (val ?? "").toLowerCase() === rule.toLowerCase();

/** Only a validated profile of the same organization whose every filled field matches the device. Most specific wins. */
export function matchProfile(dev: DeviceLike, profiles: Profile[]): Profile | null {
  const ok = profiles.filter((p) =>
    p.validated && p.organization_id === dev.organization_id &&
    (p.manufacturer || p.product_class || p.model_name) &&
    eq(p.manufacturer, dev.manufacturer) && eq(p.product_class, dev.product_class) && eq(p.model_name, dev.model_name) &&
    (!p.firmware_prefix || (dev.software_version ?? "").startsWith(p.firmware_prefix)));
  const score = (p: Profile) => [p.manufacturer, p.product_class, p.model_name, p.firmware_prefix].filter(Boolean).length;
  return ok.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Server/organization guard applied after RLS reads: ids from the client never cross tenants. */
export function sameTenant(dev: DeviceLike, server: { id: string; organization_id: string | null }, userOrgs: string[]): boolean {
  return !!server.organization_id && dev.acs_server_id === server.id && dev.organization_id === server.organization_id &&
    userOrgs.includes(server.organization_id);
}

export type CommandCheck = { ok: true } | { ok: false; reason: string };
export function canCommand(dev: DeviceLike, profile: Profile | null, kind: "wifi_2g" | "wifi_5g" | "reboot", wants?: { ssid?: boolean; password?: boolean }): CommandCheck {
  if (!dev.authorized) return { ok: false, reason: "Equipamento não aprovado" };
  if (!profile) return { ok: false, reason: "Sem perfil validado para este modelo/firmware" };
  if (kind === "reboot") return profile.allow_reboot ? { ok: true } : { ok: false, reason: "Reinício não validado neste perfil" };
  const b = kind === "wifi_2g" ? "2g" : "5g";
  if (wants?.ssid && !profile[`wifi_${b}_ssid_path`]) return { ok: false, reason: `Perfil sem suporte a SSID ${b === "2g" ? "2,4" : "5"} GHz` };
  if (wants?.password && !profile[`wifi_${b}_password_path`]) return { ok: false, reason: `Perfil sem suporte a senha ${b === "2g" ? "2,4" : "5"} GHz` };
  return { ok: true };
}

export function wifiParams(profile: Profile, band: "2g" | "5g", ssid?: string, password?: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  const sp = profile[`wifi_${band}_ssid_path`], pp = profile[`wifi_${band}_password_path`];
  if (ssid && sp) out.push([sp, ssid, "xsd:string"]);
  if (password && pp) out.push([pp, password, "xsd:string"]);
  return out;
}

/** ACS acceptance is never success by itself. 200 = applied by ACS, still needs read-back; 202 = queued. */
export function afterSubmit(httpStatus: number): TaskStatus {
  if (httpStatus === 200) return "unconfirmed";
  if (httpStatus === 202) return "queued";
  return "failed";
}

/** Read-back confirmation. SSID is compared; password is write-only and is never "confirmed". */
export function confirmWifi(expectedSsid: string | null, readSsid: string | null, passwordChanged: boolean): { status: TaskStatus; confirmation: string } {
  if (expectedSsid && readSsid !== expectedSsid) return { status: "unconfirmed", confirmation: "SSID lido difere do solicitado" };
  if (passwordChanged) return { status: "unconfirmed", confirmation: expectedSsid ? "SSID confirmado; senha é somente escrita (não verificável)" : "Senha é somente escrita (não verificável)" };
  return { status: "completed", confirmation: "SSID confirmado por leitura" };
}

/** Same request inside a 10-minute window = same key, so retries don't create duplicate tasks. Never includes the password value. */
export async function idempotencyKey(deviceId: string, kind: string, ssid: string | null, passwordChanged: boolean, now = Date.now()): Promise<string> {
  const win = Math.floor(now / 600_000);
  const raw = `${deviceId}|${kind}|${ssid ?? ""}|${passwordChanged ? 1 : 0}|${win}`;
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Strip anything that could carry credentials before storing/returning errors. */
export function safeError(s: unknown): string {
  return String(s ?? "").replace(/https?:\/\/[^@\s]+@/g, "http://***@").replace(/(Basic|Bearer)\s+\S+/gi, "$1 ***").slice(0, 300);
}
