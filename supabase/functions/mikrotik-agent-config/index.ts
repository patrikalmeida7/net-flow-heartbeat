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
    const { data: agent } = await sb.from("agents").select("id, enabled, organization_id")
      .eq("token_hash", await sha256Hex(m[1].trim())).maybeSingle();
    if (!agent || !agent.enabled) return json({ error: "invalid or disabled agent" }, 401);

    if (req.method === "GET") {
      // scope=snmp: monitoramento SNMP sem ler/descriptografar credenciais RouterOS
      const snmpOnly = new URL(req.url).searchParams.get("scope") === "snmp";
      const { data, error } = snmpOnly ? { data: [], error: null } : await sb.from("mikrotik_api_credentials") = await sb.from("mikrotik_api_credentials")
        .select("id, host, port, use_tls, username, routeros_version, concentrador_id, organization_id, concentradores(nome)")
        .eq("agent_id", agent.id).eq("enabled", true);
      if (error) throw error;
      const devices = [];
      for (const d of data ?? []) {
        const { data: pw } = await sb.rpc("get_mikrotik_api_password", { _id: d.id });
        if (!pw || d.organization_id !== agent.organization_id) continue;
        devices.push({
          id: d.id, concentrador_id: d.concentrador_id, host: d.host, port: d.port, tls: d.use_tls, user: d.username, password: pw,
          version: d.routeros_version,
          // deno-lint-ignore no-explicit-any
          nome: (d as any).concentradores?.nome ?? d.host,
        });
      }
      await sb.from("agents").update({ last_seen_at: new Date().toISOString() }).eq("id", agent.id);
      const { data: snmpRows, error: snErr } = await sb.from("snmp_credentials").select("*,concentradores(id,nome,host,organization_id),rbs(id,nome,host,organization_id)").eq("agent_id",agent.id).eq("enabled",true);
      if (snErr) throw snErr;
      const snmp_targets = (snmpRows ?? []).flatMap((s: any) => {
        const target = s.concentradores ?? s.rbs;
        if (!target?.host || target.organization_id !== agent.organization_id || s.organization_id !== agent.organization_id) return [];
        return [{target_id: target.id, kind: s.concentrador_id ? "concentrador" : "rbs", host: target.host, nome: target.nome, snmp: {enabled:true,version:s.version,port:s.port,community:s.community,username:s.username,auth_proto:s.auth_proto,auth_password:s.auth_password,priv_proto:s.priv_proto,priv_password:s.priv_password,timeout_ms:s.timeout_ms,retries:s.retries}}];
      });
      return json({ ok: true, devices, snmp_targets });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => null);
      if (body?.action === "claim_api_slot") {
        const {data, error} = await sb.rpc("claim_api_collection_slot", {_agent: agent.id});
        if (error) throw error;
        return json({claimed: data === true});
      }
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
