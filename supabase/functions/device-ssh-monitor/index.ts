// Edge Function: device-ssh-monitor
// Conecta via SSH no MikroTik usando credencial guardada em device_credentials,
// executa um conjunto fixo de comandos read-only e devolve a saída parseada.
//
// ⚠️ AVISO DE SEGURANÇA (escolha consciente do usuário):
// - Esta função roda na nuvem do Supabase e precisa que o MikroTik exponha SSH
//   à internet pública. Isso é desaconselhado.
// - A senha vive criptografada (pgsodium) no banco, mas durante a execução
//   trafega em memória do edge runtime.

import { createClient } from "npm:@supabase/supabase-js@2";
import { Client as SshClient } from "npm:ssh2@1.15.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Comandos read-only seguros (não alteram nada no MikroTik)
const READ_ONLY_COMMANDS: Array<{ key: string; cmd: string }> = [
  { key: "identity", cmd: "/system identity print" },
  { key: "resource", cmd: "/system resource print" },
  { key: "routerboard", cmd: "/system routerboard print" },
  { key: "interfaces", cmd: "/interface print stats without-paging" },
  { key: "ip_addresses", cmd: "/ip address print without-paging" },
  { key: "ppp_active_count", cmd: ":put [/ppp active print count-only]" },
  { key: "system_health", cmd: "/system health print" },
  { key: "uptime", cmd: ":put [/system resource get uptime]" },
];

interface SshExecResult {
  cmd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  duration_ms: number;
}

function sshExec(
  conn: import("npm:ssh2@1.15.0").Client,
  cmd: string,
  timeoutMs: number,
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setTimeout(() => reject(new Error(`exec timeout: ${cmd}`)), timeoutMs);
    conn.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = null;
      stream.on("close", (code: number) => {
        clearTimeout(timer);
        exitCode = code ?? null;
        resolve({ cmd, stdout, stderr, exit_code: exitCode, duration_ms: Date.now() - start });
      });
      stream.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      stream.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    });
  });
}

function connectAndRun(opts: {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
}): Promise<Record<string, SshExecResult>> {
  return new Promise((resolve, reject) => {
    const conn = new SshClient();
    const overall = setTimeout(() => {
      try { conn.end(); } catch { /* noop */ }
      reject(new Error("connection overall timeout"));
    }, opts.timeoutMs * READ_ONLY_COMMANDS.length + 5000);

    conn.on("ready", async () => {
      const out: Record<string, SshExecResult> = {};
      try {
        for (const { key, cmd } of READ_ONLY_COMMANDS) {
          try {
            out[key] = await sshExec(conn, cmd, opts.timeoutMs);
          } catch (e) {
            out[key] = {
              cmd,
              stdout: "",
              stderr: e instanceof Error ? e.message : String(e),
              exit_code: -1,
              duration_ms: 0,
            };
          }
        }
        clearTimeout(overall);
        conn.end();
        resolve(out);
      } catch (e) {
        clearTimeout(overall);
        conn.end();
        reject(e);
      }
    });
    conn.on("error", (err) => {
      clearTimeout(overall);
      reject(err);
    });
    conn.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: opts.timeoutMs,
      // MikroTik antigo às vezes precisa desses algoritmos:
      algorithms: {
        kex: [
          "curve25519-sha256",
          "curve25519-sha256@libssh.org",
          "ecdh-sha2-nistp256",
          "diffie-hellman-group14-sha256",
          "diffie-hellman-group14-sha1",
        ],
        serverHostKey: ["ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"],
      },
    });
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const t0 = Date.now();
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "missing authorization" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Cliente com JWT do usuário para validar identidade + permissão
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: isAdmin } = await userClient.rpc("has_role", {
      _user_id: userData.user.id,
      _role: "admin",
    });
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "forbidden: admin only" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const credentialId: string | undefined = body.credential_id;
    if (!credentialId || typeof credentialId !== "string") {
      return new Response(JSON.stringify({ error: "credential_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cliente service_role para ler senha decriptada
    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: cred, error: credErr } = await adminClient
      .from("device_credentials")
      .select("id, host, port, username, protocol, enabled, concentrador_id, rbs_id")
      .eq("id", credentialId)
      .maybeSingle();
    if (credErr || !cred) {
      return new Response(JSON.stringify({ error: "credential not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!cred.enabled) {
      return new Response(JSON.stringify({ error: "credential disabled" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (cred.protocol !== "ssh") {
      return new Response(JSON.stringify({ error: "only ssh supported in this slice" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: pwd, error: pwdErr } = await adminClient.rpc("get_device_credential_password", {
      _credential_id: credentialId,
    });
    if (pwdErr || !pwd) {
      return new Response(JSON.stringify({ error: "failed to decrypt password" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let results: Record<string, SshExecResult> = {};
    let success = true;
    let errorMsg: string | null = null;
    try {
      results = await connectAndRun({
        host: cred.host,
        port: cred.port,
        username: cred.username,
        password: String(pwd),
        timeoutMs: 8000,
      });
    } catch (e) {
      success = false;
      errorMsg = e instanceof Error ? e.message : String(e);
    }

    const duration = Date.now() - t0;

    // Persiste o poll
    await adminClient.from("device_ssh_polls").insert({
      credential_id: credentialId,
      concentrador_id: cred.concentrador_id,
      rbs_id: cred.rbs_id,
      success,
      error: errorMsg,
      results,
      duration_ms: duration,
    });
    await adminClient
      .from("device_credentials")
      .update({ last_poll_at: new Date().toISOString(), last_error: errorMsg })
      .eq("id", credentialId);

    return new Response(JSON.stringify({ success, error: errorMsg, results, duration_ms: duration }), {
      status: success ? 200 : 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
