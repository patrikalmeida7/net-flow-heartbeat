// Edge Function: vpn-clients-agent-sync
// Endpoint usado pelo noc-agent para:
//   GET  → puxar lista de clientes pendentes / a remover deste agente
//   POST → reportar resultado (sucesso com .conf, ou erro)
// Auth: header Authorization: Bearer <agent_token> (mesmo padrão de vpn-agent-sync)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

interface ReportPayload {
  client_id: string;
  success: boolean;
  config?: string; // .conf WireGuard gerado pelo noc-add-client
  error?: string;
  action?: "create" | "remove";
}

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

    const { data: agent, error: agErr } = await supabase
      .from("agents")
      .select("id, enabled")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (agErr) throw agErr;
    if (!agent || !agent.enabled) return json({ error: "invalid or disabled agent" }, 401);

    // GET → devolve fila de pendentes / removed solicitados
    if (req.method === "GET") {
      const { data: pending, error } = await supabase
        .from("vpn_clients")
        .select("id, nome, internal_ip, status, attempts")
        .eq("agent_id", agent.id)
        .in("status", ["pending", "provisioning"])
        .order("created_at", { ascending: true })
        .limit(20);
      if (error) throw error;

      return json({
        ok: true,
        agent_id: agent.id,
        pending: (pending ?? []).map((c) => ({
          id: c.id,
          action: "create" as const,
          nome: c.nome,
          internal_ip: c.internal_ip,
          attempts: c.attempts,
        })),
      });
    }

    // POST → agente reporta resultado
    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as ReportPayload;
      if (!body.client_id) return json({ error: "client_id required" }, 400);

      // confirma que o client pertence a este agente
      const { data: client, error: cErr } = await supabase
        .from("vpn_clients")
        .select("id, agent_id, attempts, status")
        .eq("id", body.client_id)
        .maybeSingle();
      if (cErr) throw cErr;
      if (!client || client.agent_id !== agent.id) {
        return json({ error: "client not found or not assigned to this agent" }, 404);
      }

      if (body.success) {
        // marca como ativo + grava config criptografada se veio
        if (body.config) {
          const { error: setErr } = await supabase.rpc("set_vpn_client_config", {
            _client_id: client.id,
            _config: body.config,
          });
          if (setErr) throw setErr;
        }
        const { error: upErr } = await supabase
          .from("vpn_clients")
          .update({
            status: "active",
            provisioned_at: new Date().toISOString(),
            attempts: (client.attempts ?? 0) + 1,
            last_error: null,
          })
          .eq("id", client.id);
        if (upErr) throw upErr;
      } else {
        const newAttempts = (client.attempts ?? 0) + 1;
        const finalStatus = newAttempts >= 5 ? "failed" : "pending";
        const { error: upErr } = await supabase
          .from("vpn_clients")
          .update({
            status: finalStatus,
            attempts: newAttempts,
            last_error: (body.error ?? "unknown error").slice(0, 1000),
          })
          .eq("id", client.id);
        if (upErr) throw upErr;
      }

      return json({ ok: true });
    }

    return json({ error: "method not allowed" }, 405);
  } catch (err) {
    console.error("vpn-clients-agent-sync error:", err);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
