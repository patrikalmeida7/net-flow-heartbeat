// Recebe um lote de samples SNMP do agente local.
// - Auth via header x-agent-token (mesmo segredo de agent-ingest).
// - Resolve concentrador/rbs por host.
// - Faz upsert das interfaces (descoberta).
// - Calcula bps a partir de delta de octets quando aplicável.
// - Insere amostras em metric_samples (raw, retenção 7 dias).
import { z } from "npm:zod@3";
import { corsHeaders as sdkCorsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
  ...sdkCorsHeaders,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-agent-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface IfSample {
  if_index: number;
  if_name?: string;
  if_descr?: string;
  if_alias?: string;
  if_speed_bps?: number;
  oper_status?: string;     // 'up' | 'down' | 'testing' | ...
  admin_status?: string;
  in_octets?: number;       // 64-bit counter
  out_octets?: number;
  in_counter_bits?: 32 | 64;
  out_counter_bits?: 32 | 64;
  in_errors?: number;
  out_errors?: number;
}

interface DevicePayload {
  // Identificação (use exatamente um)
  concentrador_host?: string;
  concentrador_id?: string;
  rbs_id?: string;
  snmp_valid?: boolean;
  rbs_host?: string;
  // Métricas globais
  cpu_load?: number;
  memory_used_pct?: number;
  uptime_seconds?: number;
  temperature_c?: number;
  ping_ms?: number;
  ping_loss_pct?: number;
  // Erros (string) — se setado, salvamos no last_error das credenciais
  snmp_error?: string;
  // Interfaces
  interfaces?: IfSample[];
}

interface IngestPayload {
  collected_at?: string;
  source?: "snmp" | "routeros_snapshot";
  devices: DevicePayload[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const serviceUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceUrl || !serviceKey) return new Response(JSON.stringify({error:"Service configuration missing"}), {status:500,headers:{...corsHeaders,"Content-Type":"application/json"}});
  const expected = Deno.env.get("AGENT_INGEST_TOKEN");
  const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const got = (req.headers.get("x-agent-token") || bearer || "").trim();
  let agentId: string | null = null;
  let authorized = !!got && !!expected && got === expected;
  if (!authorized && got) {
    const sbAuth = createClient(serviceUrl, serviceKey, { auth: { persistSession: false } });
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(got));
    const hash = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const { data: agent } = await sbAuth.from("agents").select("id, enabled").eq("token_hash", hash).maybeSingle();
    authorized = !!agent?.enabled;
    if (agent?.enabled) agentId = agent.id;
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    serviceUrl,
    serviceKey,
    { auth: { persistSession: false } },
  );

  let body: IngestPayload;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const schema=z.object({source:z.enum(["snmp","routeros_snapshot"]).optional(),collected_at:z.string().datetime().optional(),devices:z.array(z.object({concentrador_id:z.string().uuid().optional(),rbs_id:z.string().uuid().optional(),concentrador_host:z.string().max(255).optional(),rbs_host:z.string().max(255).optional(),snmp_valid:z.boolean().optional(),snmp_error:z.string().max(1000).optional(),uptime_seconds:z.number().finite().nonnegative().optional().nullable(),cpu_load:z.number().finite().min(0).max(100).optional().nullable(),memory_used_pct:z.number().finite().min(0).max(100).optional().nullable(),temperature_c:z.number().finite().min(-100).max(300).nullable().optional(),ping_ms:z.number().finite().nonnegative().nullable().optional(),ping_loss_pct:z.number().finite().min(0).max(100).nullable().optional(),interfaces:z.array(z.object({if_index:z.number().int().positive().optional(),routeros_id:z.string().max(50).optional(),in_octets:z.number().int().safe().nonnegative().nullable().optional(),out_octets:z.number().int().safe().nonnegative().nullable().optional(),in_counter_bits:z.union([z.literal(32),z.literal(64)]).nullable().optional(),out_counter_bits:z.union([z.literal(32),z.literal(64)]).nullable().optional(),if_name:z.string().max(255).nullable().optional(),if_descr:z.string().max(1000).nullable().optional(),if_alias:z.string().max(1000).nullable().optional(),if_speed_bps:z.number().int().safe().nonnegative().nullable().optional(),oper_status:z.string().max(30).nullable().optional(),admin_status:z.string().max(30).nullable().optional(),in_errors:z.number().int().safe().nonnegative().nullable().optional(),out_errors:z.number().int().safe().nonnegative().nullable().optional()}).passthrough()).max(10000).optional()}).passthrough().refine(d=>!!(d.concentrador_id || d.concentrador_host) !== !!(d.rbs_id || d.rbs_host),"Exatamente um equipamento é obrigatório")).min(1).max(500)});
  const parsed=schema.safeParse(body);
  if(!parsed.success) return new Response(JSON.stringify({error:parsed.error.flatten()}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
  const collectedAt = body.collected_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(collectedAt))) return new Response(JSON.stringify({error:"Stale/invalid collected_at"}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});


  // Pré-carrega mapas host → id
  const [{ data: concs }, { data: rbsList }] = await Promise.all([
    supabase.from("concentradores").select("id, host"),
    supabase.from("rbs").select("id, host"),
  ]);
  const concByHost = new Map((concs ?? []).map((c) => [c.host, c.id]));
  const rbsByHost = new Map((rbsList ?? []).filter((r) => r.host).map((r) => [r.host as string, r.id]));

  let samplesInserted = 0;
  let interfacesUpserted = 0;
  const errors: string[] = [];

  for (const dev of body.devices) {
    const concentrador_id = dev.concentrador_id ?? (dev.concentrador_host ? concByHost.get(dev.concentrador_host) ?? null : null);
    const rbs_id = dev.rbs_id ?? (dev.rbs_host ? rbsByHost.get(dev.rbs_host) ?? null : null);

    if (!concentrador_id && !rbs_id) {
      errors.push(`device sem alvo conhecido: ${dev.concentrador_host ?? dev.rbs_host ?? "?"}`);
      continue;
    }

    const target = concentrador_id ? { concentrador_id } : { rbs_id };


    const isApi=body.source === "routeros_snapshot";
    if(agentId) {
      const table=isApi ? "mikrotik_api_credentials" : "snmp_credentials";
      const {data: assignment,error: assignmentErr}=await supabase.from(table).select("id,organization_id").eq("agent_id",agentId).match(target).eq("enabled",true).maybeSingle();
      const {data: deviceOrg}=await supabase.from(concentrador_id ? "concentradores":"rbs").select("organization_id").eq("id",concentrador_id ?? rbs_id).maybeSingle();
      const {data: owner}=await supabase.from("agents").select("organization_id").eq("id",agentId).maybeSingle();
      if(assignmentErr || !assignment || assignment.organization_id !== owner?.organization_id || deviceOrg?.organization_id !== owner?.organization_id) {errors.push("Alvo não autorizado para este agente/empresa");continue;}
    }
    if(isApi) {
      if (Math.abs(Date.now()-Date.parse(collectedAt)) > 120000) {errors.push("Stale collected_at API");continue;}
      // RouterOS .id is not SNMP ifIndex. Store a separate photo, never delta/bps.
      if(concentrador_id) {
        const {error}=await supabase.from("concentradores").update({api_interfaces_snapshot:{collected_at:collectedAt,interfaces:dev.interfaces ?? []}}).eq("id",concentrador_id);
        if(error) errors.push(error.message);
      }
      continue;
    }
    // One transaction per device: interfaces, deltas, samples, health and receipt
    // either all commit or all roll back. Equal timestamps can safely retry.
    if (body.source !== "snmp") {errors.push("Atualize noc-agent: payload sem identificação de fonte");continue;}
    if (dev.interfaces?.some((i) => !Number.isInteger(i.if_index) || i.if_index <= 0)) {errors.push("ifIndex SNMP inválido");continue;}
    if (new Set(dev.interfaces?.map((i) => i.if_index)).size !== (dev.interfaces?.length ?? 0)) {errors.push("ifIndex duplicado no lote");continue;}
    const { data: result, error } = await supabase.rpc("persist_snmp_batch", {
      _agent: agentId, _at: collectedAt, _dev: { ...dev, concentrador_id, rbs_id },
    });
    if (error || result?.persistence_complete !== true) {
      const message = error?.message ?? "Persistência incompleta";
      errors.push(message);
      // This error is persistence health, NOT SNMP reachability. Never advance
      // last_attempt_at here, otherwise an identical retry could be discarded.
      const { error: logError } = await supabase.from(concentrador_id ? "concentradores" : "rbs")
        .update({ snmp_persistence_error: message.slice(0, 1000) }).eq("id", concentrador_id ?? rbs_id);
      if (logError) console.error("SNMP persistence error recording failed:", logError.message);
      continue;
    }
    samplesInserted += result.samples_inserted ?? 0;
    interfacesUpserted += result.interfaces_upserted ?? 0;

  }

  if (errors.length) console.error("metrics-ingest errors:", errors.slice(0, 20));
  const devicesWithoutData = body.devices.filter((d) => !d.snmp_error && d.cpu_load == null && !d.interfaces?.length).length;
  if (devicesWithoutData) console.warn(`metrics-ingest: ${devicesWithoutData} device(s) sem nenhuma métrica no payload`);
  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      persistence_complete: errors.length === 0,
      samples_inserted: samplesInserted,
      interfaces_upserted: interfacesUpserted,
      devices_without_data: devicesWithoutData,
      errors,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: errors.length ? 503 : 200 },
  );
});
