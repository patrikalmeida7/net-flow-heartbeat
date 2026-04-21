// Worker de provisionamento de clientes VPN
// ------------------------------------------
// - GET periódico no endpoint vpn-clients-agent-sync da edge function
// - Para cada cliente pendente, executa o comando configurado em
//   NOC_ADD_CLIENT_CMD (default: "noc-add-client {nome} {ip}")
// - Lê o .conf gerado (caminho configurável via NOC_CLIENT_CONF_PATH)
// - POSTa o resultado de volta (sucesso + .conf, ou erro)
//
// Variáveis de ambiente lidas:
//   CLIENTS_SYNC_URL            (obrigatória) – URL da edge function
//   VPN_AGENT_TOKEN             (obrigatória) – token Bearer do agente
//   NOC_ADD_CLIENT_CMD          (opcional)    – default "noc-add-client"
//   NOC_CLIENT_CONF_PATH        (opcional)    – padrão de path com {nome}
//                                               default "/etc/wireguard/clients/{nome}.conf"
//   CLIENTS_POLL_INTERVAL_MS    (opcional)    – default 15000
//   CLIENTS_CMD_TIMEOUT_MS      (opcional)    – default 60000
//
// IMPORTANTE: nome e IP já vêm validados pelo banco (CHECK regex).
// Mesmo assim, validamos de novo aqui antes de passar pra spawn.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function log(level, ...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [CLIENTS:${level}]`, ...args);
}

function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;

    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (!done) {
        try { child.kill("SIGKILL"); } catch { /* noop */ }
        done = true;
        resolve({ code: -1, stdout, stderr: stderr + "\n[timeout]" });
      }
    }, timeoutMs);

    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function readConfFile(pathTemplate, nome) {
  const path = pathTemplate.replace("{nome}", nome).replace("{name}", nome);
  try {
    const buf = await fs.readFile(path, "utf8");
    return { ok: true, conf: buf };
  } catch (err) {
    return { ok: false, error: `falha ao ler ${path}: ${err.message}` };
  }
}

async function postReport(syncUrl, token, payload) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(syncUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
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

async function fetchPending(syncUrl, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(syncUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function processClient(client, opts) {
  const { syncUrl, token, addCmd, confPath, cmdTimeoutMs } = opts;
  const { id, nome, internal_ip } = client;

  if (!NAME_RE.test(nome) || !IP_RE.test(internal_ip)) {
    log("ERROR", `cliente ${id} com nome/ip inválido: ${nome} / ${internal_ip}`);
    await postReport(syncUrl, token, {
      client_id: id,
      success: false,
      error: "nome ou IP inválido (rejeitado pelo agente)",
    });
    return;
  }

  log("INFO", `→ provisionando ${nome} (${internal_ip})`);

  // O comando pode ser "noc-add-client" ou "/usr/local/bin/noc-add-client".
  // Argumentos passados separadamente (sem shell), evitando injeção.
  const { code, stdout, stderr } = await runCommand(addCmd, [nome, internal_ip], cmdTimeoutMs);
  if (code !== 0) {
    const errMsg = (stderr || stdout || `exit ${code}`).trim().slice(0, 800);
    log("ERROR", `✗ ${nome}: comando falhou (${code}): ${errMsg}`);
    await postReport(syncUrl, token, {
      client_id: id,
      success: false,
      error: `noc-add-client exit ${code}: ${errMsg}`,
    });
    return;
  }

  const conf = await readConfFile(confPath, nome);
  if (!conf.ok) {
    log("WARN", `⚠ ${nome}: comando ok mas .conf não encontrado (${conf.error})`);
    // Reporta sucesso mesmo assim (cliente foi criado), mas sem config.
    await postReport(syncUrl, token, {
      client_id: id,
      success: true,
      error: conf.error,
    });
    return;
  }

  await postReport(syncUrl, token, {
    client_id: id,
    success: true,
    config: conf.conf,
  });
  log("INFO", `✓ ${nome}: criado e .conf reportado (${conf.conf.length} bytes)`);
}

export function startClientsLoop({ syncUrl, token, addCmd, confPath, intervalMs, cmdTimeoutMs }) {
  if (!syncUrl || !token) {
    log("INFO", "loop desativado (CLIENTS_SYNC_URL ou VPN_AGENT_TOKEN ausente)");
    return;
  }

  const opts = {
    syncUrl,
    token,
    addCmd: addCmd || "noc-add-client",
    confPath: confPath || "/etc/wireguard/clients/{nome}.conf",
    cmdTimeoutMs: cmdTimeoutMs || 60_000,
  };

  log("INFO", `loop ATIVO (sync: ${syncUrl}, cmd: ${opts.addCmd}, conf: ${opts.confPath})`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const res = await fetchPending(syncUrl, token);
      const pending = res.pending || [];
      if (pending.length === 0) return;
      log("INFO", `${pending.length} cliente(s) pendente(s)`);
      for (const c of pending) {
        try {
          await processClient(c, opts);
        } catch (e) {
          log("ERROR", `processClient ${c.nome}: ${e.message}`);
        }
      }
    } catch (e) {
      log("ERROR", `tick: ${e.message}`);
    } finally {
      running = false;
    }
  };

  // primeira execução imediata, depois intervalo
  tick();
  setInterval(tick, intervalMs || 15_000);
}
