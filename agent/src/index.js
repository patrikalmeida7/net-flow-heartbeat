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
  metrics_ingest_url,
  ingest_token,
  poll_interval_seconds = 30,
  snmp_poll_interval_seconds = 30,
  request_timeout_ms = 10000,
  concentradores = [],
  rbs = [],
} = config;

if (!ingest_url || !ingest_token) {
  console.error("[FATAL] config.json precisa de `ingest_url` e `ingest_token`.");
  process.exit(1);
}
if (concentradores.length === 0) {
  console.error("[FATAL] Nenhum concentrador definido em config.json.");
  process.exit(1);
}

// ---------- Logging ----------
function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}]`, ...args);
}

// ---------- Coleta de um MikroTik ----------
async function collect(mk) {
  const conn = new RouterOSAPI({
    host: mk.host,
    user: mk.user,
    password: mk.password,
    port: mk.port || 8728,
    timeout: Math.ceil(request_timeout_ms / 1000),
    keepalive: false,
  });

  await conn.connect();

  try {
    const [resource, identity, active] = await Promise.all([
      conn.write("/system/resource/print"),
      conn.write("/system/identity/print"),
      conn.write("/ppp/active/print"),
    ]);

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
      bytes_in: null, // /ppp/active não traz bytes; precisa de /interface monitor por sessão
      bytes_out: null,
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
      collected_at: new Date().toISOString(),
    };
  } finally {
    try { conn.close(); } catch { /* noop */ }
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
        "x-agent-token": ingest_token,
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
      collected_at: new Date().toISOString(),
    });
    log("WARN", `${mk.host} marcado como OFFLINE (${errMsg})`);
  } catch (e) {
    log("ERROR", `Falha ao reportar offline de ${mk.host}:`, e.message);
  }
}

// ---------- Loop RouterOS API (sessões PPPoE) ----------
async function tickRouterOs() {
  await Promise.all(
    concentradores.map(async (mk) => {
      const label = mk.nome || mk.host;
      try {
        const payload = await collect(mk);
        const res = await send(payload);
        log(
          "INFO",
          `✓ ${label} | online=${payload.sessions.length} | new=${res.new_connections} | dis=${res.disconnections} | evt=${res.events}`,
        );
      } catch (err) {
        log("ERROR", `✗ ${label}:`, err.message);
        await sendOfflineStatus(mk, err.message);
      }
    }),
  );
  // Mesmo se algum MK falhar individualmente, o loop em si está vivo
  touchHealth();
}

// ---------- Loop SNMP (concentradores + RBS) ----------
async function tickSnmp() {
  if (!metrics_ingest_url) return;
  const targets = [
    ...concentradores
      .filter((c) => c.snmp?.enabled)
      .map((c) => ({ kind: "concentrador", host: c.host, nome: c.nome, snmp: c.snmp })),
    ...rbs
      .filter((r) => r.snmp?.enabled)
      .map((r) => ({ kind: "rbs", host: r.host, nome: r.nome, snmp: r.snmp })),
  ];
  if (!targets.length) return;

  const devices = await Promise.all(
    targets.map(async (t) => {
      const base = t.kind === "concentrador" ? { concentrador_host: t.host } : { rbs_host: t.host };
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
      collected_at: new Date().toISOString(),
      devices,
    });
    log("INFO", `SNMP ✓ devices=${devices.length} samples=${res.samples_inserted} ifaces=${res.interfaces_upserted}`);
    touchHealth();
  } catch (err) {
    log("ERROR", "SNMP envio falhou:", err.message);
  }
}

log("INFO", `🚀 Agente iniciado. ${concentradores.length} concentrador(es), ${rbs.length} RBS.`);
log("INFO", `→ RouterOS API a cada ${poll_interval_seconds}s | SNMP a cada ${snmp_poll_interval_seconds}s`);
log("INFO", `→ Ingest URL: ${ingest_url}`);
if (metrics_ingest_url) log("INFO", `→ Metrics URL: ${metrics_ingest_url}`);

await tickRouterOs();
await tickSnmp();
setInterval(tickRouterOs, poll_interval_seconds * 1000);
setInterval(tickSnmp, snmp_poll_interval_seconds * 1000);

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

