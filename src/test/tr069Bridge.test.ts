import { describe, it, expect, beforeEach } from "vitest";
import { createHandler, Body } from "../../supabase/functions/tr069-bridge/handler";
import { decryptSecret } from "../../supabase/functions/tr069-bridge/logic";

type Row = Record<string, any>;
const KEY = "k".repeat(64);
const U_A = "00000000-0000-4000-8000-00000000000a", U_B = "00000000-0000-4000-8000-00000000000b", U_V = "00000000-0000-4000-8000-00000000000c";
const ORG_A = "10000000-0000-4000-8000-000000000001", ORG_B = "10000000-0000-4000-8000-000000000002";
const SRV_A = "20000000-0000-4000-8000-000000000001", SRV_B = "20000000-0000-4000-8000-000000000002";
const DEV_A = "30000000-0000-4000-8000-000000000001", DEV_B = "30000000-0000-4000-8000-000000000002";
const PROF = "40000000-0000-4000-8000-000000000001";
const rid = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db: Record<string, Row[]>; let seq = 0; let failOn = new Set<string>(); let onOp: ((k: string) => void) | null = null;
function fakeDb(scopeOrgs: string[] | null) {
  return {
    rpc: async (fn: string, a: Row) => {
      if (fn === "is_authorized") return { data: a._user_id !== "blocked" };
      if (fn === "has_role") return { data: a._user_id !== U_V };
      if (fn === "get_acs_password") { if (failOn.has("rpc:get_acs_password")) return { data: null, error: { message: "x" } }; return { data: db.acs_servers.find((r) => r.id === a._id)?.password_encrypted ?? null, error: null }; }
      return { data: null };
    },
    from(t: string) {
      const st: any = { op: "select", f: [] as [string, string, any][], payload: null, opts: null };
      const visible = () => (db[t] ??= []).filter((r) => (scopeOrgs && "organization_id" in r ? scopeOrgs.includes(r.organization_id) : true));
      const match = (r: Row) => st.f.every(([k, o, v]: any) => (o === "in" ? v.includes(r[k]) : r[k] === v));
      const uniq = (r: Row) => {
        if (t !== "tr069_tasks") return;
        if (db[t].some((x) => x.device_id === r.device_id && r.request_id && x.request_id === r.request_id)) throw { code: "23505" };
        if (["requested", "queued", "unknown"].includes(r.status) && db[t].some((x) => x.device_id === r.device_id && x.task_type === r.task_type && ["requested", "queued", "unknown"].includes(x.status))) throw { code: "23505" };
      };
      const exec = () => {
        onOp?.(`${t}:${st.op}`);
        if (failOn.has(`${t}:${st.op}`)) return { data: null, error: { message: "db fail" } };
        try {
          if (st.op === "select") return { data: visible().filter(match), error: null };
          if (st.op === "insert") { const rows = [].concat(st.payload).map((r: Row) => ({ id: `gen-${++seq}`, ...r })); rows.forEach((r) => { uniq(r); db[t].push(r); }); return { data: rows, error: null }; }
          if (st.op === "update") { const rows = visible().filter(match); rows.forEach((r) => Object.assign(r, st.payload)); return { data: rows, error: null }; }
          if (st.op === "upsert") {
            const keys = (st.opts?.onConflict ?? "id").split(",");
            for (const r of [].concat(st.payload) as Row[]) {
              const ex = db[t].find((x) => keys.every((k: string) => x[k] === r[k]));
              if (ex) { if (!st.opts?.ignoreDuplicates) Object.assign(ex, r); } else db[t].push({ id: `gen-${++seq}`, authorized: false, ...r });
            }
            return { data: null, error: null };
          }
        } catch (e) { return { data: null, error: e }; }
      };
      const b: any = {
        select: () => b, order: () => b, limit: () => b,
        eq: (k: string, v: any) => (st.f.push([k, "eq", v]), b), in: (k: string, v: any) => (st.f.push([k, "in", v]), b),
        insert: (p: any) => ((st.op = "insert"), (st.payload = p), b), update: (p: any) => ((st.op = "update"), (st.payload = p), b),
        upsert: (p: any, o: any) => ((st.op = "upsert"), (st.payload = p), (st.opts = o), b),
        maybeSingle: async () => { const r = exec()!; return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        single: async () => { const r = exec()!; return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
      };
      return b;
    },
  };
}

type Acs = (url: string, init?: RequestInit) => Response | Promise<Response>;
let acs: Acs; let calls: { url: string; body?: any }[]; let clock: number;
const mk = (extra: Partial<Parameters<typeof createHandler>[0]> = {}) => createHandler({
  cors: {}, secretKey: KEY, now: () => clock,
  getUid: async (a) => (a === "Bearer A" ? U_A : a === "Bearer B" ? U_B : a === "Bearer V" ? U_V : null),
  userDb: (a) => fakeDb(a === "Bearer A" || a === "Bearer V" ? [ORG_A] : [ORG_B]),
  admin: fakeDb(null),
  fetch: (async (u: string, i?: RequestInit) => { calls.push({ url: u, body: i?.body ? JSON.parse(String(i.body)) : undefined }); return acs(u, i); }) as typeof fetch,
  ...extra,
});
const call = async (h: ReturnType<typeof createHandler>, who: string, body: unknown) => {
  const r = await h(new Request("http://x", { method: "POST", headers: { Authorization: who }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
};
const J = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
const T0 = Date.parse("2026-10-27T12:00:00Z");

beforeEach(() => {
  seq = 0; calls = []; clock = T0; acs = () => J([]); failOn = new Set(); onOp = null;
  db = {
    organization_members: [{ user_id: U_A, organization_id: ORG_A }, { user_id: U_V, organization_id: ORG_A }, { user_id: U_B, organization_id: ORG_B }],
    acs_servers: [
      { id: SRV_A, organization_id: ORG_A, nbi_url: "https://acs-a.example", username: "noc", enabled: true, allow_insecure_http: false, sync_cursor: 0 },
      { id: SRV_B, organization_id: ORG_B, nbi_url: "https://acs-b.example", username: "noc", enabled: true, allow_insecure_http: false, sync_cursor: 0 },
    ],
    tr069_devices: [
      { id: DEV_A, organization_id: ORG_A, acs_server_id: SRV_A, genie_id: "G-A", authorized: true, manufacturer: "Huawei", product_class: "HG8145V5", model_name: null, software_version: "V5" },
      { id: DEV_B, organization_id: ORG_B, acs_server_id: SRV_B, genie_id: "G-B", authorized: true, manufacturer: "Huawei", product_class: "HG8145V5", model_name: null, software_version: "V5" },
    ],
    tr069_profiles: [{ id: PROF, organization_id: ORG_A, validated: true, pilot_device_id: null, manufacturer: "Huawei", product_class: "HG8145V5", model_name: null, firmware_prefix: null,
      wifi_2g_ssid_path: "P.SSID", wifi_2g_password_path: "P.PSK", wifi_5g_ssid_path: null, wifi_5g_password_path: null, allow_reboot: true }],
    tr069_tasks: [], tr069_audit: [], acs_server_secrets: [],
  };
});

describe("bridge: inicialização, schemas e permissões", () => {
  it("OPTIONS, sem token e JSON inválido", async () => {
    const h = mk();
    expect((await h(new Request("http://x", { method: "OPTIONS" }))).status).toBe(200);
    expect((await call(h, "", { action: "test", server_id: SRV_A })).status).toBe(401);
    expect((await call(h, "Bearer A", { action: "nope" })).status).toBe(400);
    expect(Body.safeParse({ action: "set_wifi", device_id: DEV_A, request_id: rid(1), band: "2g" }).success).toBe(false);
    expect(Body.safeParse({ action: "reboot", device_id: DEV_A, request_id: rid(1), confirm: false }).success).toBe(false);
  });
  it("não-admin não executa ações de escrita", async () => {
    expect((await call(mk(), "Bearer V", { action: "approve", device_id: DEV_A, authorized: false })).status).toBe(403);
  });
  it("empresa A não alcança servidor/equipamento da empresa B por ID", async () => {
    const h = mk();
    expect((await call(h, "Bearer A", { action: "sync", server_id: SRV_B })).status).toBe(404);
    expect((await call(h, "Bearer A", { action: "approve", device_id: DEV_B, authorized: false })).status).toBe(404);
    expect(db.tr069_devices.find((d) => d.id === DEV_B)!.authorized).toBe(true);
    expect(calls.length).toBe(0);
  });
  it("HTTP sem exceção de laboratório é recusado", async () => {
    db.acs_servers[0].nbi_url = "http://1.2.3.4:7558";
    const r = await call(mk(), "Bearer A", { action: "test", server_id: SRV_A });
    expect(r.status).toBe(400); expect(calls.length).toBe(0);
  });
  it("senha do ACS fica cifrada com chave do backend e não volta na resposta", async () => {
    const r = await call(mk(), "Bearer A", { action: "set_password", server_id: SRV_A, password: "s3gredo" });
    expect(JSON.stringify(r.body)).not.toContain("s3gredo");
    const c = db.acs_server_secrets[0].ciphertext as string;
    expect(c).not.toContain("s3gredo");
    expect(await decryptSecret(c, KEY, SRV_A)).toBe("s3gredo");
    await expect(decryptSecret(c, "x".repeat(64), SRV_A)).rejects.toThrow();
    expect(JSON.stringify(db.tr069_audit)).not.toContain("s3gredo");
  });
  it("aprovação/bloqueio auditados", async () => {
    await call(mk(), "Bearer A", { action: "approve", device_id: DEV_A, authorized: false });
    expect(db.tr069_audit[0]).toMatchObject({ action: "block", result: "ok", actor: U_A, organization_id: ORG_A, device_id: DEV_A });
  });
});

describe("bridge: comandos e confirmação", () => {
  const wifi = (n: number, extra: Record<string, unknown> = {}) => ({ action: "set_wifi", device_id: DEV_A, request_id: rid(n), band: "2g", ssid: "Novo", ...extra });

  it("SSID antigo em cache (timestamp anterior) não confirma", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : J([{ _id: "G-A", _deviceId: { _Manufacturer: "Huawei", _ProductClass: "HG8145V5" }, P: { SSID: { _value: "Novo", _timestamp: "2026-10-27T11:00:00Z" } } }]));
    const r = await call(mk(), "Bearer A", wifi(1));
    expect(r.body.status).toBe("unconfirmed");
  });
  it("leitura posterior com valor igual confirma; senha nunca confirma", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : J([{ _id: "G-A", _deviceId: { _Manufacturer: "Huawei", _ProductClass: "HG8145V5" }, P: { SSID: { _value: "Novo", _timestamp: "2026-10-27T12:00:05Z" } } }]));
    expect((await call(mk(), "Bearer A", wifi(1))).body.status).toBe("completed");
    const r = await call(mk(), "Bearer A", wifi(2, { password: "12345678" }));
    expect(r.body.status).toBe("unconfirmed");
    expect(JSON.stringify(db.tr069_tasks)).not.toContain("12345678");
    expect(JSON.stringify(db.tr069_audit)).not.toContain("12345678");
  });
  it("timeout após envio = desconhecido; retry com mesmo id não reenvia; outra solicitação bloqueada", async () => {
    acs = () => { throw new Error("timeout"); };
    const h = mk();
    expect((await call(h, "Bearer A", wifi(1))).body.status).toBe("unknown");
    const sent = calls.length;
    const again = await call(h, "Bearer A", wifi(1));
    expect(again.body.duplicate).toBe(true); expect(calls.length).toBe(sent);
    const other = await call(h, "Bearer A", wifi(2, { ssid: "Outro" }));
    expect(other.status).toBe(409); expect(calls.length).toBe(sent);
  });
  it("duas alterações de senha legítimas diferentes são permitidas após a anterior finalizar", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t" }) : J([]));
    const h = mk();
    await call(h, "Bearer A", wifi(1, { ssid: undefined, password: "aaaaaaaa" }));
    const r = await call(h, "Bearer A", wifi(2, { ssid: undefined, password: "bbbbbbbb" }));
    expect(r.status).toBe(200); expect(db.tr069_tasks.length).toBe(2);
  });
  it("faults indisponível mantém pendente; mudança de perfil não afeta reconciliação", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t9" }, 202) : J([]));
    const h = mk();
    expect((await call(h, "Bearer A", wifi(1))).body.status).toBe("queued");
    db.tr069_profiles[0].wifi_2g_ssid_path = "OUTRO.PATH";
    acs = (u) => (u.includes("/faults") ? J({}, 503) : J([]));
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A });
    expect(db.tr069_tasks[0].status).toBe("queued");
    acs = (u, i) => (u.includes("/faults") ? J([]) : i?.method === "POST" ? J({}) : u.includes("/tasks") ? J([]) : J([{ _id: "G-A", _deviceId: { _Manufacturer: "Huawei", _ProductClass: "HG8145V5" }, P: { SSID: { _value: "Novo", _timestamp: "2026-10-27T12:10:00Z" } } }]));
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A });
    expect(db.tr069_tasks[0].status).toBe("completed");
    // Leitura passiva já trouxe observação posterior: usa o caminho congelado e não enfileira leitura no CPE.
    expect(calls.some((c) => decodeURIComponent(c.url).includes("P.SSID"))).toBe(true);
    expect(calls.some((c) => decodeURIComponent(c.url).includes("OUTRO.PATH") || c.body?.parameterNames?.[0] === "OUTRO.PATH")).toBe(false);
  });
  it("perfil não validado só libera o equipamento piloto", async () => {
    db.tr069_profiles[0].validated = false;
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t" }, 202) : J([]));
    expect((await call(mk(), "Bearer A", wifi(1))).status).toBe(400);
    db.tr069_profiles[0].pilot_device_id = DEV_A;
    expect((await call(mk(), "Bearer A", wifi(2))).status).toBe(200);
    db.tr069_devices.push({ ...db.tr069_devices[0], id: "30000000-0000-4000-8000-000000000003", genie_id: "G-C" });
    expect((await call(mk(), "Bearer A", { ...wifi(3), device_id: "30000000-0000-4000-8000-000000000003" })).status).toBe(400);
  });
});

describe("bridge: sincronização retomável", () => {
  it("para no limite de tempo como parcial e retoma do cursor sem perder aprovação", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ _id: `G-${i}`, _deviceId: { _Manufacturer: "Huawei", _ProductClass: "HG8145V5" } }));
    db.tr069_devices.push({ id: "keep", organization_id: ORG_A, acs_server_id: SRV_A, genie_id: "G-0", authorized: true });
    acs = (u) => { const s = Number(new URL(u).searchParams.get("skip")); clock += 30000; return J(all.slice(s, s + 2)); };
    const h = mk({ pageSize: 2, syncBudgetMs: 20000 });
    const r1 = await call(h, "Bearer A", { action: "sync", server_id: SRV_A });
    expect(r1.body).toMatchObject({ complete: false, cursor: 2 });
    expect(db.acs_servers[0].sync_status).toBe("partial");
    await call(h, "Bearer A", { action: "sync", server_id: SRV_A });
    const r3 = await call(h, "Bearer A", { action: "sync", server_id: SRV_A });
    expect(r3.body.complete).toBe(true);
    expect(db.tr069_devices.find((d) => d.genie_id === "G-0")!.authorized).toBe(true);
    expect(db.tr069_devices.filter((d) => d.acs_server_id === SRV_A && d.genie_id?.startsWith("G-") && d.genie_id !== "G-A").length).toBe(5);
  });
});

describe("bridge: migração da senha antiga", () => {
  const legacyOnly = () => { db.acs_servers[0].password_encrypted = "antiga"; };
  it("falha na gravação cifrada preserva a credencial antiga", async () => {
    legacyOnly(); failOn.add("acs_server_secrets:upsert");
    const r = await call(mk(), "Bearer A", { action: "test", server_id: SRV_A });
    expect(r.status).toBe(200);
    expect(db.acs_servers[0].password_encrypted).toBe("antiga");
    expect(db.acs_server_secrets).toHaveLength(0);
  });
  it("falha na releitura também preserva a antiga; nova chamada retoma e conclui", async () => {
    legacyOnly();
    let n = 0; onOp = (k) => { if (k === "acs_server_secrets:select" && ++n === 2) failOn.add("acs_server_secrets:select"); };
    expect((await call(mk(), "Bearer A", { action: "test", server_id: SRV_A })).status).toBe(200); // usa a antiga
    expect(db.acs_servers[0].password_encrypted).toBe("antiga");
    failOn.clear(); onOp = null;
    await call(mk(), "Bearer A", { action: "test", server_id: SRV_A });
    expect(db.acs_servers[0].password_encrypted).toBeNull();
    expect(await decryptSecret(db.acs_server_secrets[0].ciphertext, KEY, SRV_A)).toBe("antiga");
  });
  it("falha ao limpar a antiga é retomada na próxima chamada", async () => {
    legacyOnly(); failOn.add("acs_servers:update");
    await call(mk(), "Bearer A", { action: "test", server_id: SRV_A });
    expect(db.acs_server_secrets).toHaveLength(1); expect(db.acs_servers[0].password_encrypted).toBe("antiga");
    failOn.clear();
    await call(mk(), "Bearer A", { action: "test", server_id: SRV_A });
    expect(db.acs_servers[0].password_encrypted).toBeNull();
  });
  it("senha nova gravada durante a migração não é sobrescrita pela antiga", async () => {
    legacyOnly();
    const h = mk();
    // set_password concorrente entra exatamente antes da gravação da migração
    let done = false;
    onOp = (k) => { if (k === "acs_server_secrets:upsert" && !done) { done = true; db.acs_server_secrets.push({ server_id: SRV_A, ciphertext: "PENDING" }); } };
    const { encryptSecret } = await import("../../supabase/functions/tr069-bridge/logic");
    const nova = await encryptSecret("nova", KEY, SRV_A);
    onOp = (k) => { if (k === "acs_server_secrets:upsert" && !done) { done = true; db.acs_server_secrets.push({ server_id: SRV_A, ciphertext: nova }); } };
    let auth = "";
    acs = (u, i) => { auth = String((i?.headers as Record<string, string>)?.Authorization ?? ""); return J([]); };
    await call(h, "Bearer A", { action: "test", server_id: SRV_A });
    expect(await decryptSecret(db.acs_server_secrets[0].ciphertext, KEY, SRV_A)).toBe("nova");
    expect(atob(auth.replace("Basic ", ""))).toBe("noc:nova");
    expect(db.acs_servers[0].password_encrypted).toBeNull();
  });
  it("erro na leitura da credencial não segue com senha vazia", async () => {
    failOn.add("acs_server_secrets:select");
    const r = await call(mk(), "Bearer A", { action: "test", server_id: SRV_A });
    expect(r.status).toBe(500); expect(calls).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain("antiga");
  });
});

describe("bridge: reconciliação de tarefas não confirmadas", () => {
  const dev = (ssid: { v: string; ts: string } | null, extra: Row = {}) => J([{ _id: "G-A", _deviceId: { _Manufacturer: "Huawei", _ProductClass: "HG8145V5" }, ...(ssid ? { P: { SSID: { _value: ssid.v, _timestamp: ssid.ts } } } : {}), ...extra }]);
  const posts = () => calls.filter((c) => c.body);
  it("unconfirmed recebe depois observação válida e conclui, sem reenviar o comando", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : dev({ v: "Velho", ts: "2026-10-27T11:00:00Z" }));
    const h = mk();
    expect((await call(h, "Bearer A", { action: "set_wifi", device_id: DEV_A, request_id: rid(1), band: "2g", ssid: "Novo" })).body.status).toBe("unconfirmed");
    const before = posts().filter((c) => c.body.name === "setParameterValues").length;
    clock += 10 * 60000;
    acs = (u, i) => (i?.method === "POST" ? J({}) : dev({ v: "Novo", ts: "2026-10-27T12:09:00Z" }));
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A });
    expect(db.tr069_tasks[0].status).toBe("completed");
    expect(posts().filter((c) => c.body.name === "setParameterValues").length).toBe(before);
  });
  it("leituras limitadas e espaçadas: sem duplicar nem reenviar", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : dev(null));
    const h = mk();
    await call(h, "Bearer A", { action: "set_wifi", device_id: DEV_A, request_id: rid(2), band: "2g", ssid: "Novo" });
    const reads = () => posts().filter((c) => c.body.name === "getParameterValues").length;
    const r0 = reads();
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A }); // dentro do intervalo
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A });
    expect(reads()).toBe(r0);
    for (let i = 0; i < 6; i++) { clock += 6 * 60000; await call(h, "Bearer A", { action: "task_status", device_id: DEV_A }); }
    expect(reads()).toBe(3); // READ_MAX
    expect(db.tr069_tasks[0].status).toBe("unconfirmed");
    expect(posts().filter((c) => c.body.name === "setParameterValues")).toHaveLength(1);
  });
  it("senha write-only não é consultada nem confirmada", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : dev(null));
    const h = mk();
    await call(h, "Bearer A", { action: "set_wifi", device_id: DEV_A, request_id: rid(3), band: "2g", password: "12345678" });
    const n = calls.length;
    for (let i = 0; i < 3; i++) { clock += 10 * 60000; await call(h, "Bearer A", { action: "task_status", device_id: DEV_A }); }
    expect(calls.length).toBe(n);
    expect(db.tr069_tasks[0].status).toBe("unconfirmed");
  });
  it("reinício: contato posterior isolado não confirma; boot posterior confirma", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : dev(null, { _lastInform: "2026-10-27T12:05:00Z", _lastBoot: "2026-10-26T00:00:00Z" }));
    const h = mk();
    expect((await call(h, "Bearer A", { action: "reboot", device_id: DEV_A, request_id: rid(4), confirm: true })).body.status).toBe("unconfirmed");
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A });
    expect(db.tr069_tasks[0].status).toBe("unconfirmed");
    acs = () => dev(null, { _lastBoot: "2026-10-27T12:03:00Z" });
    await call(h, "Bearer A", { action: "task_status", device_id: DEV_A });
    expect(db.tr069_tasks[0].status).toBe("completed");
    expect(posts().filter((c) => c.body.name === "reboot")).toHaveLength(1);
  });
  it("erro ao consultar o ACS mantém inconclusivo", async () => {
    acs = (u, i) => (i?.method === "POST" ? J({ _id: "t1" }) : dev(null));
    const h = mk();
    await call(h, "Bearer A", { action: "set_wifi", device_id: DEV_A, request_id: rid(5), band: "2g", ssid: "Novo" });
    acs = () => { throw new Error("down"); };
    clock += 10 * 60000;
    expect((await call(h, "Bearer A", { action: "task_status", device_id: DEV_A })).status).toBe(200);
    expect(db.tr069_tasks[0].status).toBe("unconfirmed");
  });
});
