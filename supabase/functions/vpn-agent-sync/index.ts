// Edge Function: vpn-agent-sync
// O agente VPN faz POST aqui a cada N segundos com:
//   { status: [{ vpn_connection_id, online, latency_ms, ... }], events: [...] }
// Recebe de volta a lista de túneis que deve manter ativos (com chaves descriptografadas).
// Auth: header Authorization: Bearer <agent_token>. Token é validado via sha256 contra agents.token_hash.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface StatusReport {
  vpn_connection_id: string;
  online: boolean;
  latency_ms?: number | null;
  last_handshake_at?: string | null;
  rx_bytes?: number | null;
  tx_bytes?: number | null;
  internal_ip?: string | null;
  uptime_seconds?: number | null;
  last_error?: string | null;
}

interface EventReport {
  vpn_connection_id: string;
  event_type: "connect" | "disconnect" | "error" | "reconnect" | "config_applied";
  message?: string;
  metadata?: Record<string, unknown>;
}

interface SyncPayload {
  status?: StatusReport[];
  events?: EventReport[];
  agent_version?: string;
}

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return json({ error: "missing bearer" }, 401);
    const token = m[1].trim();
    const tokenHash = await sha256Hex(token);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // 1. validar agente
    const { data: agent, error: agErr } = await supabase
      .from("agents")
      .select("id, nome, enabled")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (agErr) throw agErr;
    if (!agent || !agent.enabled) return json({ error: "invalid or disabled agent" }, 401);

    const xff = req.headers.get("x-forwarded-for");
    const clientIp = xff ? xff.split(",")[0].trim() : null;

    const body = (await req.json().catch(() => ({}))) as SyncPayload;

    // 2. atualizar last_seen do agente
    await supabase
      .from("agents")
      .update({
        last_seen_at: new Date().toISOString(),
        last_ip: clientIp,
        version: body.agent_version ?? null,
      })
      .eq("id", agent.id);

    // 3. ingerir status
    const previousStates = new Map<string, boolean>();
    if (body.status?.length) {
      const ids = body.status.map((s) => s.vpn_connection_id);
      const { data: prev } = await supabase
        .from("vpn_status")
        .select("vpn_connection_id, online")
        .in("vpn_connection_id", ids);
      for (const p of prev ?? []) previousStates.set(p.vpn_connection_id, p.online);

      const rows = body.status.map((s) => ({
        vpn_connection_id: s.vpn_connection_id,
        online: !!s.online,
        latency_ms: s.latency_ms ?? null,
        last_handshake_at: s.last_handshake_at ?? null,
        rx_bytes: s.rx_bytes ?? 0,
        tx_bytes: s.tx_bytes ?? 0,
        internal_ip: s.internal_ip ?? null,
        uptime_seconds: s.uptime_seconds ?? null,
        last_error: s.last_error ?? null,
        reported_at: new Date().toISOString(),
      }));
      const { error } = await supabase.from("vpn_status").upsert(rows, { onConflict: "vpn_connection_id" });
      if (error) throw error;

      // gerar eventos automáticos quando status muda
      const autoEvents: Array<Record<string, unknown>> = [];
      const autoAlerts: Array<Record<string, unknown>> = [];
      for (const s of body.status) {
        const prev = previousStates.get(s.vpn_connection_id);
        if (prev === undefined) continue;
        if (prev && !s.online) {
          autoEvents.push({
            vpn_connection_id: s.vpn_connection_id,
            event_type: "disconnect",
            message: s.last_error ?? "VPN ficou offline",
          });
        } else if (!prev && s.online) {
          autoEvents.push({
            vpn_connection_id: s.vpn_connection_id,
            event_type: "connect",
            message: "VPN restabelecida",
          });
        }
      }
      if (autoEvents.length) await supabase.from("vpn_events").insert(autoEvents);
    }

    // 4. ingerir eventos manuais do agente
    if (body.events?.length) {
      const rows = body.events.map((e) => ({
        vpn_connection_id: e.vpn_connection_id,
        event_type: e.event_type,
        message: e.message ?? null,
        metadata: e.metadata ?? null,
      }));
      const { error } = await supabase.from("vpn_events").insert(rows);
      if (error) throw error;
    }

    // 5. devolver desired-state das conexões deste agente
    const { data: conns, error: cErr } = await supabase
      .from("vpn_connections")
      .select("*")
      .eq("agent_id", agent.id)
      .eq("enabled", true);
    if (cErr) throw cErr;

    const tunnels = [];
    for (const c of conns ?? []) {
      const t: Record<string, unknown> = {
        id: c.id,
        nome: c.nome,
        protocol: c.protocol,
        endpoint_host: c.endpoint_host,
        endpoint_port: c.endpoint_port,
        desired_state: c.desired_state,
      };
      if (c.protocol === "wireguard") {
        const { data: privKey } = await supabase.rpc("get_vpn_secret", {
          _connection_id: c.id,
          _field: "wg_private_key",
        });
        let psk: string | null = null;
        if (c.wg_preshared_key_encrypted) {
          const { data } = await supabase.rpc("get_vpn_secret", {
            _connection_id: c.id,
            _field: "wg_preshared_key",
          });
          psk = data;
        }
        t.wg = {
          private_key: privKey,
          peer_public_key: c.wg_peer_public_key,
          preshared_key: psk,
          address_cidr: c.wg_address_cidr,
          allowed_ips: c.wg_allowed_ips,
          dns: c.wg_dns,
          persistent_keepalive: c.wg_persistent_keepalive ?? 25,
        };
      } else if (c.protocol === "openvpn") {
        const { data: cfg } = await supabase.rpc("get_vpn_secret", {
          _connection_id: c.id,
          _field: "ovpn_config",
        });
        let pwd: string | null = null;
        if (c.ovpn_password_encrypted) {
          const { data } = await supabase.rpc("get_vpn_secret", {
            _connection_id: c.id,
            _field: "ovpn_password",
          });
          pwd = data;
        }
        t.ovpn = {
          config: cfg,
          username: c.ovpn_username,
          password: pwd,
        };
      }
      tunnels.push(t);
    }

    return json({ ok: true, agent_id: agent.id, tunnels });
  } catch (err) {
    console.error("vpn-agent-sync error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
