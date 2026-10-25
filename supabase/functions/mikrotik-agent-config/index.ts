// Edge Function: mikrotik-agent-config
// GET  → lista de MikroTiks (API RouterOS) que este agente deve monitorar
// POST → { results: [{ id, ok, error? }] } atualiza last_poll_at / last_error
// Auth: Authorization: Bearer <agent_token>
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!m) return json({ error: "missing bearer" }, 401);
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { data: agent } = await sb.from("agents").select("id, enabled")
      .eq("token_hash", await sha256Hex(m[1].trim())).maybeSingle();
    if (!agent || !agent.enabled) return json({ error: "invalid or disabled agent" }, 401);

    if (req.method === "GET") {
      const { data, error } = await sb.from("mikrotik_api_credentials")
        .select("id, host, port, use_tls, username, routeros_version, concentrador_id, concentradores(nome)")
        .eq("agent_id", agent.id).eq("enabled", true);
      if (error) throw error;
      const devices = [];
      for (const d of data ?? []) {
        const { data: pw } = await sb.rpc("get_mikrotik_api_password", { _id: d.id });
        if (!pw) continue;
        // deno-lint-ignore no-explicit-any
        const cid = (d as any).concentrador_id;
        const { data: sn } = cid
          ? await sb.from("snmp_credentials").select("*").eq("concentrador_id", cid).eq("enabled", true).maybeSingle()
          : { data: null };
        devices.push({
          id: d.id, host: d.host, port: d.port, tls: d.use_tls, user: d.username, password: pw,
          version: d.routeros_version,
          snmp: sn ? {
            enabled: true, version: sn.version, port: sn.port, community: sn.community,
            username: sn.username, auth_proto: sn.auth_proto, auth_password: sn.auth_password,
            priv_proto: sn.priv_proto, priv_password: sn.priv_password,
            timeout_ms: sn.timeout_ms, retries: sn.retries,
          } : undefined,
          // deno-lint-ignore no-explicit-any
          nome: (d as any).concentradores?.nome ?? d.host,
        });
      }
      await sb.from("agents").update({ last_seen_at: new Date().toISOString() }).eq("id", agent.id);
      return json({ ok: true, devices });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      const results = Array.isArray(body?.results) ? body.results.slice(0, 500) : null;
      if (!results) return json({ error: "results[] required" }, 400);
      const now = new Date().toISOString();
      for (const r of results) {
        if (typeof r?.id !== "string") continue;
        await sb.from("mikrotik_api_credentials")
          .update({ last_poll_at: now, last_error: r.ok ? null : String(r.error ?? "erro").slice(0, 500) })
          .eq("id", r.id).eq("agent_id", agent.id);
      }
      return json({ ok: true });
    }
    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
