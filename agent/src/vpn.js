// VPN orchestrator (WireGuard + OpenVPN)
// ----------------------------------------
// - Faz polling no edge function vpn-agent-sync
// - Recebe lista de túneis "desired_state=up" com chaves
// - Materializa /etc/wireguard/lov-<id>.conf  e  /etc/openvpn/client/lov-<id>.conf
// - Roda `wg-quick up/down` ou systemd `openvpn-client@`
// - Mede latência (ping) e reporta status

import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const WG_DIR = process.env.LOV_WG_DIR || "/etc/wireguard";
const OVPN_DIR = process.env.LOV_OVPN_DIR || "/etc/openvpn/client";
const PREFIX = "lov-"; // todos arquivos gerenciados começam com isso

// estado em memória: id -> { protocol, lastDesired, lastApplied, startedAt }
const state = new Map();

function log(level, ...args) {
  console.log(`[${new Date().toISOString()}] [VPN/${level}]`, ...args);
}

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: 20_000, ...opts });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, stdout: err.stdout || "", stderr: err.stderr || err.message };
  }
}

// --- WireGuard ---
function buildWgConfig(t) {
  const wg = t.wg || {};
  const lines = [
    "[Interface]",
    `PrivateKey = ${wg.private_key}`,
    wg.address_cidr ? `Address = ${wg.address_cidr}` : null,
    wg.dns ? `DNS = ${wg.dns}` : null,
    "",
    "[Peer]",
    `PublicKey = ${wg.peer_public_key}`,
    wg.preshared_key ? `PresharedKey = ${wg.preshared_key}` : null,
    `Endpoint = ${t.endpoint_host}:${t.endpoint_port}`,
    `AllowedIPs = ${wg.allowed_ips || "0.0.0.0/0"}`,
    `PersistentKeepalive = ${wg.persistent_keepalive ?? 25}`,
  ].filter(Boolean);
  return lines.join("\n") + "\n";
}

function wgIface(id) {
  // wg-quick aceita interface = nome do arquivo .conf (sem extensão), max 15 chars
  return `${PREFIX}${id.slice(0, 8)}`;
}

async function wgUp(t) {
  const iface = wgIface(t.id);
  const file = path.join(WG_DIR, `${iface}.conf`);
  fs.mkdirSync(WG_DIR, { recursive: true });
  fs.writeFileSync(file, buildWgConfig(t), { mode: 0o600 });
  // garantir down antes (para reaplicar config)
  await run("wg-quick", ["down", iface]).catch(() => {});
  const r = await run("wg-quick", ["up", iface]);
  if (!r.ok) throw new Error(`wg-quick up falhou: ${r.stderr}`);
  return iface;
}

async function wgDown(id) {
  const iface = wgIface(id);
  await run("wg-quick", ["down", iface]).catch(() => {});
  const file = path.join(WG_DIR, `${iface}.conf`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

async function wgStatus(id) {
  const iface = wgIface(id);
  const r = await run("wg", ["show", iface, "dump"]);
  if (!r.ok) return { online: false, last_handshake_at: null, rx_bytes: 0, tx_bytes: 0 };
  // formato dump: linha 1 = interface, linhas seguintes = peers (tab-separated)
  const lines = r.stdout.trim().split("\n");
  if (lines.length < 2) return { online: false };
  const peer = lines[1].split("\t");
  // peer: pubkey psk endpoint allowed_ips latest_handshake rx tx keepalive
  const lhs = parseInt(peer[4], 10) || 0;
  const rx = parseInt(peer[5], 10) || 0;
  const tx = parseInt(peer[6], 10) || 0;
  const last_handshake_at = lhs > 0 ? new Date(lhs * 1000).toISOString() : null;
  // online se handshake nos últimos 3 min
  const online = lhs > 0 && Date.now() / 1000 - lhs < 180;
  return { online, last_handshake_at, rx_bytes: rx, tx_bytes: tx };
}

// --- OpenVPN ---
function ovpnFile(id) {
  return path.join(OVPN_DIR, `${PREFIX}${id.slice(0, 8)}.conf`);
}
function ovpnAuthFile(id) {
  return path.join(OVPN_DIR, `${PREFIX}${id.slice(0, 8)}.auth`);
}
function ovpnUnit(id) {
  return `openvpn-client@${PREFIX}${id.slice(0, 8)}`;
}

async function ovpnUp(t) {
  const ovpn = t.ovpn || {};
  fs.mkdirSync(OVPN_DIR, { recursive: true });
  let cfg = ovpn.config || "";
  if (ovpn.username) {
    const authFile = ovpnAuthFile(t.id);
    fs.writeFileSync(authFile, `${ovpn.username}\n${ovpn.password ?? ""}\n`, { mode: 0o600 });
    if (!/^auth-user-pass/m.test(cfg)) cfg += `\nauth-user-pass ${authFile}\n`;
    else cfg = cfg.replace(/^auth-user-pass.*/m, `auth-user-pass ${authFile}`);
  }
  fs.writeFileSync(ovpnFile(t.id), cfg, { mode: 0o600 });
  await run("systemctl", ["restart", ovpnUnit(t.id)]);
}

async function ovpnDown(id) {
  await run("systemctl", ["stop", ovpnUnit(id)]).catch(() => {});
  for (const f of [ovpnFile(id), ovpnAuthFile(id)]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

async function ovpnStatus(id) {
  const r = await run("systemctl", ["is-active", ovpnUnit(id)]);
  return { online: r.ok && r.stdout.trim() === "active" };
}

// --- ping latency (best-effort) ---
async function pingMs(host) {
  if (!host) return null;
  const r = await run("ping", ["-c", "1", "-W", "2", host]);
  if (!r.ok) return null;
  const m = r.stdout.match(/time=([\d.]+)\s*ms/);
  return m ? Math.round(parseFloat(m[1])) : null;
}

// --- reconciliação ---
export async function reconcileTunnels(tunnels) {
  const events = [];
  const statusReports = [];
  const desiredIds = new Set(tunnels.filter((t) => t.desired_state === "up").map((t) => t.id));

  // 1. desligar túneis que não devem mais estar ativos
  for (const id of state.keys()) {
    if (!desiredIds.has(id)) {
      const s = state.get(id);
      try {
        if (s.protocol === "wireguard") await wgDown(id);
        else await ovpnDown(id);
        log("INFO", `↓ down ${s.protocol} ${id}`);
        events.push({ vpn_connection_id: id, event_type: "disconnect", message: "Desligado por desired_state=down" });
      } catch (e) {
        log("ERROR", `falha ao desligar ${id}:`, e.message);
      }
      state.delete(id);
    }
  }

  // 2. ligar/atualizar túneis desejados
  for (const t of tunnels) {
    if (t.desired_state !== "up") continue;
    const prev = state.get(t.id);
    const isNew = !prev;
    try {
      if (t.protocol === "wireguard") {
        if (!t.wg?.private_key || !t.wg?.peer_public_key) {
          throw new Error("WireGuard sem private_key/peer_public_key");
        }
        // sempre re-aplica (idempotente; wg-quick down+up se já existe)
        if (isNew) await wgUp(t);
      } else if (t.protocol === "openvpn") {
        if (!t.ovpn?.config) throw new Error("OpenVPN sem config");
        if (isNew) await ovpnUp(t);
      } else {
        throw new Error(`protocolo desconhecido: ${t.protocol}`);
      }
      if (isNew) {
        state.set(t.id, { protocol: t.protocol, startedAt: Date.now() });
        events.push({
          vpn_connection_id: t.id,
          event_type: "config_applied",
          message: `Túnel ${t.protocol} aplicado`,
        });
        log("INFO", `↑ up ${t.protocol} ${t.nome} (${t.id})`);
      }
    } catch (e) {
      log("ERROR", `falha ao subir ${t.nome}:`, e.message);
      events.push({ vpn_connection_id: t.id, event_type: "error", message: e.message });
      statusReports.push({
        vpn_connection_id: t.id,
        online: false,
        last_error: e.message,
      });
      continue;
    }

    // 3. coletar status
    const st = state.get(t.id);
    const live = t.protocol === "wireguard" ? await wgStatus(t.id) : await ovpnStatus(t.id);
    const internalIp = t.protocol === "wireguard" ? (t.wg?.address_cidr?.split("/")[0] ?? null) : null;
    // ping para o "outro lado" — usa o primeiro IP de allowed_ips (WG) ou endpoint (OVPN)
    let pingTarget = null;
    if (t.protocol === "wireguard" && t.wg?.allowed_ips) {
      const first = t.wg.allowed_ips.split(",")[0].trim().split("/")[0];
      pingTarget = first;
    }
    const latency = await pingMs(pingTarget);

    statusReports.push({
      vpn_connection_id: t.id,
      online: !!live.online,
      latency_ms: latency,
      last_handshake_at: live.last_handshake_at ?? null,
      rx_bytes: live.rx_bytes ?? 0,
      tx_bytes: live.tx_bytes ?? 0,
      internal_ip: internalIp,
      uptime_seconds: st ? Math.floor((Date.now() - st.startedAt) / 1000) : null,
      last_error: null,
    });
  }

  return { events, statusReports };
}

// --- loop principal ---
export async function startVpnLoop({ syncUrl, token, intervalSec = 15, agentVersion = "1.0.0" }) {
  if (!syncUrl || !token) {
    log("WARN", "VPN sync desabilitado: faltando syncUrl ou token");
    return;
  }

  let firstReport = true;

  async function tick() {
    try {
      // reportar status atual + receber túneis desejados
      const initialBody = firstReport
        ? { agent_version: agentVersion }
        : await collectAndBuildBody(agentVersion);

      const res = await fetch(syncUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(initialBody),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const { tunnels = [] } = await res.json();

      const { events, statusReports } = await reconcileTunnels(tunnels);

      // segundo POST com status fresco + eventos
      if (statusReports.length || events.length) {
        await fetch(syncUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ status: statusReports, events, agent_version: agentVersion }),
        });
      }

      firstReport = false;
      log("INFO", `tick ok: ${tunnels.length} túneis, ${statusReports.filter((s) => s.online).length} online`);
    } catch (err) {
      log("ERROR", "sync falhou:", err.message);
    }
  }

  async function collectAndBuildBody(version) {
    // re-coleta status dos túneis em estado conhecido para enviar antes do próximo poll
    const status = [];
    for (const [id, s] of state) {
      const live = s.protocol === "wireguard" ? await wgStatus(id) : await ovpnStatus(id);
      status.push({
        vpn_connection_id: id,
        online: !!live.online,
        last_handshake_at: live.last_handshake_at ?? null,
        rx_bytes: live.rx_bytes ?? 0,
        tx_bytes: live.tx_bytes ?? 0,
        uptime_seconds: Math.floor((Date.now() - s.startedAt) / 1000),
      });
    }
    return { status, agent_version: version };
  }

  await tick();
  setInterval(tick, intervalSec * 1000);
}
