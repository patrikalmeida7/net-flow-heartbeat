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
  ingest_token,
  poll_interval_seconds = 30,
  request_timeout_ms = 10000,
  concentradores = [],
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
async function send(payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), request_timeout_ms);
  try {
    const res = await fetch(ingest_url, {
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

// ---------- Loop principal ----------
async function tick() {
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
}

log("INFO", `🚀 Agente iniciado. ${concentradores.length} concentrador(es). Intervalo: ${poll_interval_seconds}s`);
log("INFO", `→ Ingest URL: ${ingest_url}`);

await tick();
setInterval(tick, poll_interval_seconds * 1000);

// Graceful shutdown
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("INFO", `Recebido ${sig}, encerrando.`);
    process.exit(0);
  });
}
