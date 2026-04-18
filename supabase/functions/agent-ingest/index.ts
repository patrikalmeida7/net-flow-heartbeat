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
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const expectedToken = Deno.env.get("AGENT_INGEST_TOKEN");
    if (!expectedToken) {
      return json({ error: "Server misconfigured" }, 500);
    }

    const providedToken = req.headers.get("x-agent-token");
    if (!providedToken || providedToken !== expectedToken) {
      return json({ error: "Unauthorized" }, 401);
    }

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

    // 1) Upsert concentrador (chave: host)
    const { data: existing, error: selErr } = await supabase
      .from("concentradores")
      .select("id, status, usuarios_online")
      .eq("host", c.host)
      .maybeSingle();

    if (selErr) throw selErr;

    let concentradorId: string;
    let previousStatus: string | null = null;
    let previousOnline = 0;

    if (existing) {
      concentradorId = existing.id;
      previousStatus = existing.status;
      previousOnline = existing.usuarios_online ?? 0;

      const { error: updErr } = await supabase
        .from("concentradores")
        .update({
          nome: c.nome ?? undefined,
          identidade: c.identidade ?? null,
          modelo: c.modelo ?? null,
          versao_routeros: c.versao_routeros ?? null,
          status: c.status ?? "online",
          cpu_load: c.cpu_load ?? null,
          memory_used_pct: c.memory_used_pct ?? null,
          uptime_seconds: c.uptime_seconds ?? null,
          usuarios_online: c.usuarios_online ?? body.sessions.filter((s) => s.online).length,
          ultima_coleta: now,
        })
        .eq("id", concentradorId);
      if (updErr) throw updErr;
    } else {
      const { data: ins, error: insErr } = await supabase
        .from("concentradores")
        .insert({
          host: c.host,
          nome: c.nome ?? c.identidade ?? c.host,
          identidade: c.identidade ?? null,
          modelo: c.modelo ?? null,
          versao_routeros: c.versao_routeros ?? null,
          status: c.status ?? "online",
          cpu_load: c.cpu_load ?? null,
          memory_used_pct: c.memory_used_pct ?? null,
          uptime_seconds: c.uptime_seconds ?? null,
          usuarios_online: c.usuarios_online ?? body.sessions.filter((s) => s.online).length,
          ultima_coleta: now,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      concentradorId = ins.id;
    }

    // 2) Reconciliar sessões PPPoE
    // Buscar sessões ativas atuais no banco para este concentrador
    const { data: dbSessions, error: dbSessErr } = await supabase
      .from("pppoe_sessions")
      .select("id, username, online")
      .eq("concentrador_id", concentradorId)
      .eq("online", true);
    if (dbSessErr) throw dbSessErr;

    const incomingOnline = new Map<string, SessionPayload>();
    for (const s of body.sessions) {
      if (s.online) incomingOnline.set(s.username, s);
    }

    const dbOnlineMap = new Map<string, string>(); // username -> id
    for (const s of dbSessions ?? []) dbOnlineMap.set(s.username, s.id);

    // Conexões novas
    const newConnections: SessionPayload[] = [];
    for (const [user, s] of incomingOnline) {
      if (!dbOnlineMap.has(user)) newConnections.push(s);
    }

    // Desconexões
    const disconnected: { id: string; username: string }[] = [];
    for (const [user, id] of dbOnlineMap) {
      if (!incomingOnline.has(user)) disconnected.push({ id, username: user });
    }

    // Atualizar sessões existentes (uptime, bytes)
    const updates: Promise<unknown>[] = [];
    for (const [user, s] of incomingOnline) {
      const id = dbOnlineMap.get(user);
      if (id) {
        updates.push(
          supabase
            .from("pppoe_sessions")
            .update({
              ip_address: s.ip_address ?? null,
              caller_id: s.caller_id ?? null,
              interface: s.interface ?? null,
              uptime_seconds: s.uptime_seconds ?? null,
              bytes_in: s.bytes_in ?? 0,
              bytes_out: s.bytes_out ?? 0,
              ultima_atualizacao: now,
            })
            .eq("id", id),
        );
      }
    }
    await Promise.all(updates);

    // Inserir novas conexões
    if (newConnections.length > 0) {
      const rows = newConnections.map((s) => ({
        concentrador_id: concentradorId,
        username: s.username,
        ip_address: s.ip_address ?? null,
        caller_id: s.caller_id ?? null,
        interface: s.interface ?? null,
        uptime_seconds: s.uptime_seconds ?? null,
        bytes_in: s.bytes_in ?? 0,
        bytes_out: s.bytes_out ?? 0,
        online: true,
        conectado_em: now,
        ultima_atualizacao: now,
      }));
      const { error } = await supabase.from("pppoe_sessions").insert(rows);
      if (error) throw error;
    }

    // Marcar desconexões
    if (disconnected.length > 0) {
      const ids = disconnected.map((d) => d.id);
      const { error } = await supabase
        .from("pppoe_sessions")
        .update({ online: false, desconectado_em: now })
        .in("id", ids);
      if (error) throw error;
    }

    // 3) Eventos
    const events: Array<Record<string, unknown>> = [];
    for (const c2 of newConnections) {
      events.push({
        tipo: "connect",
        concentrador_id: concentradorId,
        username: c2.username,
        descricao: `Conexão PPPoE: ${c2.username}`,
        metadata: { ip: c2.ip_address, interface: c2.interface },
      });
    }
    for (const d of disconnected) {
      events.push({
        tipo: "disconnect",
        concentrador_id: concentradorId,
        username: d.username,
        descricao: `Desconexão PPPoE: ${d.username}`,
      });
    }

    // Evento de mudança de status do concentrador
    const newStatus = c.status ?? "online";
    if (previousStatus && previousStatus !== newStatus) {
      if (newStatus === "offline") {
        events.push({
          tipo: "device_down",
          concentrador_id: concentradorId,
          descricao: `Concentrador ${c.nome ?? c.host} ficou offline`,
        });
        // Cria alerta crítico
        await supabase.from("alertas").insert({
          titulo: `Concentrador offline: ${c.nome ?? c.host}`,
          descricao: `Sem resposta da API RouterOS em ${c.host}`,
          severidade: "critical",
          status: "active",
          concentrador_id: concentradorId,
        });
      } else if (previousStatus === "offline" && newStatus === "online") {
        events.push({
          tipo: "device_up",
          concentrador_id: concentradorId,
          descricao: `Concentrador ${c.nome ?? c.host} voltou online`,
        });
      }
    }

    if (events.length > 0) {
      const { error } = await supabase.from("eventos").insert(events);
      if (error) throw error;
    }

    return json({
      ok: true,
      concentrador_id: concentradorId,
      synced: incomingOnline.size,
      new_connections: newConnections.length,
      disconnections: disconnected.length,
      events: events.length,
    });
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
