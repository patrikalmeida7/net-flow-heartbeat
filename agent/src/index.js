// Agente Coletor MikroTik → Lovable Cloud
// -----------------------------------------
// - Lê config.json (lista de concentradores MikroTik)
// - Conecta em cada um via API RouterOS
// - Coleta /system/resource, /system/identity, /ppp/active
// - Envia tudo para a Edge Function `agent-ingest` no Lovable Cloud
// - Roda em loop com intervalo configurável (default: 30s)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RouterOSAPI } from "node-routeros";
import { collectSnmp } from "./snmp.js";
import { startVpnLoop } from "./vpn.js";
import { startClientsLoop } from "./clients.js";

// Marker pro healthcheck do Docker. Atualizado após cada tick
// bem-sucedido. Se ficar > 90s sem mtime novo, container fica
// unhealthy e Watchtower/Docker reinicia.
const HEALTH_MARKER = process.env.HEALTH_MARKER || "/tmp/noc-agent.healthy";
function touchHealth() {
  try {
    const now = new Date();
    fs.writeFileSync(HEALTH_MARKER, now.toISOString());
  } catch {
    /* noop — não derruba o agente se /tmp falhar */
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------- Config ----------
const configPath = process.env.AGENT_CONFIG || path.join(ROOT, "config.json");
if (!fs.existsSync(configPath)) {
  console.error(`[FATAL] Config não encontrada em ${configPath}. Copie config.example.json para config.json.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

const {
  ingest_url,
  metrics_ingest_url: cfgMetricsUrl,
  ingest_token,
  poll_interval_seconds: cfgPoll = 10,
  snmp_poll_interval_seconds = 30,
  request_timeout_ms = 10000,
  concentradores: staticConcentradores = [],
  rbs = [],
} = config;
const poll_interval_seconds = Number(process.env.POLL_INTERVAL_SECONDS) || Math.min(cfgPoll, 10);
// Se não vier no config, deriva a URL de métricas a partir da URL de ingestão
const metrics_ingest_url =
  cfgMetricsUrl || process.env.METRICS_INGEST_URL || (ingest_url ? ingest_url.replace(/agent-ingest\/?$/, "metrics-ingest") : null);
// Interfaces físicas/lógicas via API RouterOS (sem SNMP) — throttle em 30s
let snmpTargets = [];

// Lista viva: estáticos do config.json + dinâmicos vindos do painel (MIKROTIK_CONFIG_URL)
let concentradores = [...staticConcentradores];
const MK_CONFIG_URL = process.env.MIKROTIK_CONFIG_URL;
const MK_TOKEN = process.env.VPN_AGENT_TOKEN;

if (!ingest_url || !ingest_token) {
  console.error("[FATAL] config.json precisa de `ingest_url` e `ingest_token`.");
  process.exit(1);
}
if (concentradores.length === 0 && !MK_CONFIG_URL) {
  console.error("[FATAL] Nenhum concentrador em config.json e MIKROTIK_CONFIG_URL não definido.");
  process.exit(1);
}

async function refreshDynamicDevices() {
  if (!MK_CONFIG_URL || !MK_TOKEN) return;
  try {
    const res = await fetch(MK_CONFIG_URL, { headers: { Authorization: `Bearer ${MK_TOKEN}` }, signal: AbortSignal.timeout(request_timeout_ms) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { devices = [], snmp_targets = [] } = await res.json();
    snmpTargets = snmp_targets;
    const dyn = devices.map((d) => ({
      id: d.id, concentrador_id: d.concentrador_id, nome: d.nome, host: d.host, port: d.port, tls: d.tls,
      user: d.user, password: d.password, version: d.version, dynamic: true,
      snmp: d.snmp || undefined,
    }));
    const dynHosts = new Set(dyn.map((d) => d.host));
    concentradores = [...staticConcentradores.filter((c) => !dynHosts.has(c.host)), ...dyn];
  } catch (e) {
    snmpTargets = [];
    concentradores = [];
    console.log(`[${new Date().toISOString()}] [WARN] Falha ao buscar MikroTiks do painel: ${e.message}`);
  }
}

async function reportDynamic(results) {
  if (!MK_CONFIG_URL || !MK_TOKEN || !results.length) return;
  try {
    await fetch(MK_CONFIG_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${MK_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ results }),
    });
  } catch { /* noop */ }
}

// ---------- Logging ----------
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

// ---------- Coleta de um MikroTik ----------
// Connection lives only within one scheduled snapshot and is always closed.
const pool = new Map();
function poolKey(mk) { return `${mk.host}:${mk.port}:${mk.user}:${mk.password}:${mk.tls ? 1 : 0}`; }
function dropConn(mk) {
  const k = poolKey(mk);
  const c = pool.get(k);
  pool.delete(k);
  if (c) { try { c.close(); } catch { /* noop */ } }
}
async function getConn(mk) {
  const k = poolKey(mk);
  const cached = pool.get(k);
  if (cached && cached.connected) return cached;
  if (cached) dropConn(mk);
  const conn = new RouterOSAPI({
    host: mk.host,
    user: mk.user,
    password: mk.password,
    port: mk.port || (mk.tls ? 8729 : 8728),
    tls: mk.tls ? { rejectUnauthorized: false } : undefined,
    timeout: Math.ceil(request_timeout_ms / 1000),
    keepalive: false,
  });
  conn.on("error", () => dropConn(mk));
  conn.on("close", () => pool.delete(k));
  pool.set(k, conn);
  await conn.connect();
  log("INFO", `🔗 Sessão de sincronização aberta com ${mk.nome || mk.host}`);
  return conn;
}

async function collect(mk) {
  const conn = await getConn(mk);

  try {
    const [resource, identity, active, ifaces] = await Promise.all([
      conn.write("/system/resource/print"),
      conn.write("/system/identity/print"),
      conn.write("/ppp/active/print"),
      conn.write("/interface/print", ["?=type=pppoe-in", "=.proplist=name,rx-byte,tx-byte"]).catch(() => []),
    ]);
    // Interface dinâmica do PPPoE se chama "<pppoe-usuario>": tx = download do cliente, rx = upload
    const bytesByUser = new Map();
    for (const i of ifaces) {
      const m = /^<pppoe-(.+)>$/.exec(i.name || "");
      if (m) bytesByUser.set(m[1], { down: Number(i["tx-byte"]) || 0, up: Number(i["rx-byte"]) || 0 });
    }

    const r = resource[0] || {};
    const id = identity[0] || {};

    const totalMem = Number(r["total-memory"]) || 0;
    const freeMem = Number(r["free-memory"]) || 0;
    const memUsedPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 100) : null;

    const sessions = active.map((s) => ({
      username: s.name,
      ip_address: s.address || null,
      caller_id: s["caller-id"] || null,
      interface: s["service"] || s["interface"] || null,
      uptime_seconds: parseRouterOSUptime(s.uptime),
      bytes_in: bytesByUser.get(s.name)?.down ?? null,
      bytes_out: bytesByUser.get(s.name)?.up ?? null,
      online: true,
    }));

    return {
      concentrador: {
        host: mk.host,
        nome: mk.nome || id.name || mk.host,
        identidade: id.name || null,
        modelo: r["board-name"] || null,
        versao_routeros: r.version || null,
        status: "online",
        cpu_load: r["cpu-load"] != null ? Number(r["cpu-load"]) : null,
        memory_used_pct: memUsedPct,
        uptime_seconds: parseRouterOSUptime(r.uptime),
        usuarios_online: sessions.length,
      },
      sessions,
      source: "routeros_snapshot",
      concentrador_id: mk.concentrador_id,
      collected_at: new Date().toISOString(),
    };
  } catch (e) {
    dropConn(mk);
    throw e;
  }
}

// RouterOS retorna uptime tipo "1w2d3h4m5s"
function parseRouterOSUptime(str) {
  if (!str || typeof str !== "string") return null;
  const re = /(\d+)(w|d|h|m|s)/g;
  const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    total += Number(m[1]) * (mult[m[2]] || 0);
  }
  return total || null;
}

// ---------- Envio para Lovable Cloud ----------
async function postJson(url, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), request_timeout_ms);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agent-token": MK_TOKEN || ingest_token,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function send(payload) {
  return postJson(ingest_url, payload);
}

// ---------- Envio de status offline (quando coleta falha) ----------
async function sendOfflineStatus(mk, errMsg) {
  try {
    await send({
      concentrador: {
        host: mk.host,
        nome: mk.nome || mk.host,
        status: "offline",
        usuarios_online: 0,
      },
      sessions: [],
      source: "routeros_snapshot",
      concentrador_id: mk.concentrador_id,
      error: String(errMsg || "").slice(0, 300),
      collected_at: new Date().toISOString(),
    });
    log("WARN", `${mk.host} falha API registrada (não altera saúde SNMP) (${errMsg})`);
  } catch (e) {
    log("ERROR", `Falha ao reportar offline de ${mk.host}:`, e.message);
  }
}

// ---------- Interfaces via API RouterOS → metrics-ingest ----------
async function pushRouterOsInterfaces(mk) {
  if (!metrics_ingest_url) return;
  const conn = pool.get(poolKey(mk));
  if (!conn?.connected) throw new Error("Conexão API encerrada; sem reconexão fora da sincronização");
  const list = await conn.write("/interface/print", [
    "=.proplist=.id,name,type,comment,running,disabled,rx-byte,tx-byte,rx-error,tx-error",
  ]);
  const interfaces = list
    .filter((i) => i.type !== "pppoe-in" && !/^<.*>$/.test(i.name || ""))
    .map((i) => ({
      routeros_id: i[".id"],
      if_name: i.name,
      if_descr: i.type || i.name,
      if_alias: i.comment || null,
      oper_status: i.running === "true" ? "up" : "down",
      admin_status: i.disabled === "true" ? "down" : "up",
      in_octets: Number(i["rx-byte"]) || 0,
      out_octets: Number(i["tx-byte"]) || 0,
      in_errors: Number(i["rx-error"]) || 0,
      out_errors: Number(i["tx-error"]) || 0,
    }));
  await postJson(metrics_ingest_url, {
    collected_at: new Date().toISOString(),
    source: "routeros_snapshot",
    devices: [{ concentrador_id: mk.concentrador_id, concentrador_host: mk.host, interfaces }],
  });
  log("INFO", `📈 ${mk.nome || mk.host} | ${interfaces.length} interfaces enviadas`);
}

// ---------- Loop RouterOS API (sessões PPPoE) ----------
// conn.write() do node-routeros não tem timeout próprio: uma sessão TLS "meio-morta"
// pendura a coleta para sempre (heartbeat continua, mas nada chega ao agent-ingest).
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: timeout ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

let routerOsBusy = false;
async function tickRouterOs() {
  if (routerOsBusy) { log("WARN", "Ciclo RouterOS anterior ainda em andamento — pulando"); return; }
  routerOsBusy = true;
  const results = [];
  try {
    await Promise.all(
      concentradores.filter((mk) => mk.user && mk.password).map(async (mk) => {
        const label = mk.nome || mk.host;
        try {
          const payload = await withTimeout(collect(mk), request_timeout_ms * 2, `coleta ${label}`);
          const res = await send(payload);
          if (res.ok !== true) throw new Error(`API gravação: ${(res.write_errors ?? []).join(" | ")}`);
          await withTimeout(pushRouterOsInterfaces(mk), request_timeout_ms * 2, `interfaces ${label}`)
            .catch((e) => { dropConn(mk); log("WARN", `Interfaces ✗ ${label}: ${e.message}`); });
          log(
            "INFO",
            `✓ ${label} | online=${payload.sessions.length} | new=${res.new_connections} | dis=${res.disconnections} | evt=${res.events}`,
          );
          if (mk.dynamic) results.push({ id: mk.id, ok: true });
        } catch (err) {
          dropConn(mk);
          log("ERROR", `✗ ${label}:`, err.message);
          if (mk.dynamic) results.push({ id: mk.id, ok: false, error: err.message });
          await sendOfflineStatus(mk, err.message);
        } finally { dropConn(mk); }
      }),
    );
    await reportDynamic(results);
    // Saúde só é renovada se ao menos um equipamento foi coletado com sucesso
    // API never renews primary SNMP health.
  } finally {
    routerOsBusy = false;
  }
}

// ---------- Loop SNMP (concentradores + RBS) ----------
let snmpBusy = false;
async function tickSnmp() {
  if (!metrics_ingest_url || snmpBusy) return;
  snmpBusy = true;
  try { await tickSnmpInner(); } finally { snmpBusy = false; }
}
async function tickSnmpInner() {
  const targets = MK_CONFIG_URL ? snmpTargets : [
    ...concentradores.filter((c) => c.snmp?.enabled).map((c) => ({kind: "concentrador", host: c.host, snmp: c.snmp})),
    ...rbs.filter((r) => r.snmp?.enabled).map((r) => ({kind: "rbs", host: r.host, snmp: r.snmp})),
  ];
  if (!targets.length) return;

  const devices = await Promise.all(
    targets.map(async (t) => {
      const base = t.kind === "concentrador" ? { concentrador_host: t.host, concentrador_id: t.target_id } : { rbs_host: t.host, rbs_id: t.target_id };
      try {
        const data = await collectSnmp(t.host, t.snmp);
        return { ...base, ...data };
      } catch (err) {
        log("ERROR", `SNMP ✗ ${t.nome || t.host}: ${err.message}`);
        return { ...base, snmp_error: err.message, interfaces: [] };
      }
    }),
  );

  try {
    const res = await postJson(metrics_ingest_url, {
      source: "snmp",
      collected_at: new Date().toISOString(),
      devices,
    });
    log("INFO", `SNMP ✓ devices=${devices.length} samples=${res.samples_inserted} ifaces=${res.interfaces_upserted}`);
    if (res.errors?.length) log("ERROR", "metrics-ingest gravou com erros:", res.errors.slice(0, 5).join(" | "));
    if (res.devices_without_data) log("WARN", `SNMP: ${res.devices_without_data} equipamento(s) responderam sem métricas`);
    if (res.ok && devices.some((d) => d.snmp_valid && !d.snmp_error)) touchHealth();
  } catch (err) {
    log("ERROR", "SNMP envio falhou:", err.message);
  }
}

log("INFO", `🚀 Agente iniciado. ${concentradores.length} concentrador(es), ${rbs.length} RBS.`);
log("INFO", "→ API 00/06/12/18 America/Bahia (sem catch-up); SNMP principal 30s");
log("INFO", `→ Ingest URL: ${ingest_url}`);
if (metrics_ingest_url) log("INFO", `→ Metrics URL: ${metrics_ingest_url}`);

await refreshDynamicDevices();
setInterval(refreshDynamicDevices, 60_000);
if (MK_CONFIG_URL) log("INFO", `→ MikroTiks dinâmicos do painel: ${concentradores.length} total`);
// No API collection at startup. Slots are claimed durably in the backend.
await tickSnmp();
async function scheduledApi() {
  if (!MK_CONFIG_URL || !MK_TOKEN || routerOsBusy) return;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "America/Bahia", hour: "2-digit", minute: "2-digit", hourCycle: "h23"}).formatToParts(new Date()).map((p) => [p.type,p.value]));
  if (!["00","06","12","18"].includes(parts.hour) || parts.minute !== "00") return;
  try {
    const r = await fetch(MK_CONFIG_URL, {method: "POST", headers: {Authorization: `Bearer ${MK_TOKEN}`, "Content-Type": "application/json"}, body: JSON.stringify({action: "claim_api_slot"}), signal: AbortSignal.timeout(request_timeout_ms)});
    if (!r.ok) throw new Error(`slot HTTP ${r.status}`);
    if ((await r.json()).claimed) await tickRouterOs();
  } catch (e) { log("ERROR", "API slot:", e.message); }
}
setInterval(scheduledApi, 15000);
setInterval(tickSnmp, 30000);

// VPN loop (opcional — só sobe se as variáveis de ambiente estiverem definidas)
if (process.env.VPN_AGENT_TOKEN && process.env.VPN_SYNC_URL) {
  log("INFO", `→ VPN loop ATIVO (sync: ${process.env.VPN_SYNC_URL})`);
  startVpnLoop({
    syncUrl: process.env.VPN_SYNC_URL,
    token: process.env.VPN_AGENT_TOKEN,
    intervalMs: 15_000,
  });
} else {
  log("INFO", "→ VPN loop desativado (defina VPN_AGENT_TOKEN e VPN_SYNC_URL para ativar)");
}

// Clients loop (provisionamento automático via noc-add-client)
if (process.env.VPN_AGENT_TOKEN && process.env.CLIENTS_SYNC_URL) {
  log("INFO", `→ Clients loop ATIVO (sync: ${process.env.CLIENTS_SYNC_URL})`);
  startClientsLoop({
    syncUrl: process.env.CLIENTS_SYNC_URL,
    token: process.env.VPN_AGENT_TOKEN,
    addCmd: process.env.NOC_ADD_CLIENT_CMD,
    confPath: process.env.NOC_CLIENT_CONF_PATH,
    intervalMs: Number(process.env.CLIENTS_POLL_INTERVAL_MS) || 15_000,
    cmdTimeoutMs: Number(process.env.CLIENTS_CMD_TIMEOUT_MS) || 60_000,
  });
} else {
  log("INFO", "→ Clients loop desativado (defina VPN_AGENT_TOKEN e CLIENTS_SYNC_URL para ativar)");
}

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("INFO", `Recebido ${sig}, encerrando.`);
    process.exit(0);
  });
}

