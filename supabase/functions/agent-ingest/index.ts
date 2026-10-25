// Edge Function: agent-ingest
// Recebe dados do agente coletor local (MikroTik) e grava no banco usando service role.
// Autenticação: header x-agent-token deve bater com o secret AGENT_INGEST_TOKEN.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ConcentradorPayload {
  host: string;
  nome?: string;
  identidade?: string | null;
  modelo?: string | null;
  versao_routeros?: string | null;
  status?: "online" | "warning" | "offline" | "unknown";
  cpu_load?: number | null;
  memory_used_pct?: number | null;
  uptime_seconds?: number | null;
  usuarios_online?: number;
}

interface SessionPayload {
  username: string;
  ip_address?: string | null;
  caller_id?: string | null;
  interface?: string | null;
  uptime_seconds?: number | null;
  bytes_in?: number | null;
  bytes_out?: number | null;
  online: boolean;
}

interface IngestPayload {
  concentrador: ConcentradorPayload;
  sessions: SessionPayload[];
  collected_at?: string;
  error?: string;
  source?: string;
  concentrador_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const expectedToken = Deno.env.get("AGENT_INGEST_TOKEN");
    const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
    const providedToken = (req.headers.get("x-agent-token") || bearer || "").trim();
    if (!providedToken) return json({ error: "Unauthorized" }, 401);

    let authorized = !!expectedToken && providedToken === expectedToken;
    let agentId: string | null = null;
    if (!authorized) {
      const sbAuth = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        { auth: { persistSession: false } },
      );
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(providedToken));
      const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
      const { data: agent } = await sbAuth.from("agents").select("id, enabled")
        .eq("token_hash", hash).maybeSingle();
      if (agent?.enabled) {
        authorized = true;
        agentId = agent.id;
        await sbAuth.from("agents").update({ last_seen_at: new Date().toISOString() }).eq("id", agent.id);
      }
    }
    if (!authorized) return json({ error: "Unauthorized" }, 401);
    void agentId;

    const body = (await req.json()) as IngestPayload;
    if (!body?.concentrador?.host) {
      return json({ error: "Invalid payload: concentrador.host required" }, 400);
    }
    if (!Array.isArray(body.sessions)) {
      return json({ error: "Invalid payload: sessions must be an array" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const now = new Date().toISOString();
    const c = body.concentrador;

    // All API agents (including legacy transition) are snapshots only; never infer events.
    let query = supabase.from("concentradores").select("id,organization_id");
    query = body.concentrador_id ? query.eq("id",body.concentrador_id) : query.eq("host",c.host);
    const {data: target,error: targetErr} = await query.maybeSingle();
    if (targetErr) throw targetErr;
    if (!target) return json({error:"Equipamento não cadastrado"},404);
    if (agentId) {
      const {data: assigned} = await supabase.from("mikrotik_api_credentials").select("id").eq("agent_id",agentId).eq("concentrador_id",target.id).eq("organization_id",target.organization_id ?? "00000000-0000-0000-0000-000000000000").maybeSingle();
      // Null-organization legacy assignments are checked separately without widening scope.
      const {data: legacy} = target.organization_id === null ? await supabase.from("mikrotik_api_credentials").select("id").eq("agent_id",agentId).eq("concentrador_id",target.id).is("organization_id",null).maybeSingle() : {data:null};
      if (!assigned && !legacy) return json({error:"Equipamento não atribuído ao agente"},403);
    }
    const concentradorId = target.id;
    const failure = c.status === "offline" || !!body.error;
    const {error: apiErr} = await supabase.from("concentradores").update({
      api_last_attempt_at:now,api_last_error: failure ? body.error ?? "Sem resposta API" : null,
      ...(!failure ? {api_last_success_at:now,usuarios_online:body.sessions.filter((s)=>s.online).length,identidade:c.identidade,modelo:c.modelo,versao_routeros:c.versao_routeros} : {}),
    }).eq("id",concentradorId);
    if (apiErr) throw apiErr;
    if (failure) return json({ok:true,collection_failure:true,events:0,synced:0});
    const {data: current,error: currentErr} = await supabase.from("pppoe_sessions").select("id,username").eq("concentrador_id",concentradorId).eq("online",true);
    if (currentErr) throw currentErr;
    const incoming = new Map(body.sessions.filter((s)=>s.online).map((s)=>[s.username,s]));
    const known = new Map((current ?? []).map((s)=>[s.username,s.id]));
    const writeErrors: string[]=[];
    // Missing clients were absent in this photo; their disconnect time/count is UNKNOWN.
    const absent=(current ?? []).filter((s)=>!incoming.has(s.username)).map((s)=>s.id);
    if(absent.length) {
      const {error}=await supabase.from("pppoe_sessions").update({online:false,desconectado_em:null,ultima_atualizacao:now}).in("id",absent);
      if(error) writeErrors.push(error.message);
    }
    for(const [username,session] of incoming) {
      const row={concentrador_id:concentradorId,username,ip_address:session.ip_address ?? null,caller_id:session.caller_id ?? null,interface:session.interface ?? null,uptime_seconds:session.uptime_seconds ?? null,bytes_in:session.bytes_in ?? null,bytes_out:session.bytes_out ?? null,online:true,ultima_atualizacao:now};
      const id=known.get(username);
      const {error}=id ? await supabase.from("pppoe_sessions").update(row).eq("id",id) : await supabase.from("pppoe_sessions").insert(row);
      if(error) writeErrors.push(error.message);
    }
    const {error:snapshotErr}=await supabase.from("connection_snapshots").upsert({concentrador_id:concentradorId,organization_id:target.organization_id,bucket_at:now,online_count:incoming.size},{onConflict:"concentrador_id,bucket_at"});
    if(snapshotErr) writeErrors.push(snapshotErr.message);
    if(writeErrors.length) console.error("API snapshot write errors",writeErrors);
    return json({ok:!writeErrors.length,events:0,synced:incoming.size,write_errors:writeErrors});
  } catch (err) {
    console.error("agent-ingest error:", err);
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: msg }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
