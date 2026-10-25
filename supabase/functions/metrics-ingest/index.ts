// Recebe um lote de samples SNMP do agente local.
// - Auth via header x-agent-token (mesmo segredo de agent-ingest).
// - Resolve concentrador/rbs por host.
// - Faz upsert das interfaces (descoberta).
// - Calcula bps a partir de delta de octets quando aplicável.
// - Insere amostras em metric_samples (raw, retenção 7 dias).
import { z } from "npm:zod@3";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const corsHeaders = {
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

  const expected = Deno.env.get("AGENT_INGEST_TOKEN");
  const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
  const got = (req.headers.get("x-agent-token") || bearer || "").trim();
  let agentId: string | null = null;
  let authorized = !!got && !!expected && got === expected;
  if (!authorized && got) {
    const sbAuth = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
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
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
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

  const schema=z.object({source:z.enum(["snmp","routeros_snapshot"]).optional(),collected_at:z.string().datetime().optional(),devices:z.array(z.object({concentrador_id:z.string().uuid().optional(),rbs_id:z.string().uuid().optional(),concentrador_host:z.string().max(255).optional(),rbs_host:z.string().max(255).optional(),snmp_valid:z.boolean().optional(),snmp_error:z.string().max(1000).optional(),uptime_seconds:z.number().finite().nonnegative().optional().nullable(),cpu_load:z.number().finite().min(0).max(100).optional().nullable(),memory_used_pct:z.number().finite().min(0).max(100).optional().nullable(),interfaces:z.array(z.object({if_index:z.number().int().positive().optional(),routeros_id:z.string().max(50).optional(),in_octets:z.number().finite().nonnegative().nullable().optional(),out_octets:z.number().finite().nonnegative().nullable().optional()}).passthrough()).max(10000).optional()}).passthrough().refine(d=>!!(d.concentrador_id || d.concentrador_host) !== !!(d.rbs_id || d.rbs_host),"Exatamente um equipamento é obrigatório")).min(1).max(500)});
  const parsed=schema.safeParse(body);
  if(!parsed.success) return new Response(JSON.stringify({error:parsed.error.flatten()}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
  const collectedAt = body.collected_at ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(collectedAt)) || Math.abs(Date.now()-Date.parse(collectedAt))>120000) return new Response(JSON.stringify({error:"Stale/invalid collected_at"}),{status:400,headers:{...corsHeaders,"Content-Type":"application/json"}});
  const collectedAtMs = new Date(collectedAt).getTime();

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
    const samples: Array<Record<string, unknown>> = [];

    const isApi=body.source === "routeros_snapshot";
    if(agentId) {
      const table=isApi ? "mikrotik_api_credentials" : "snmp_credentials";
      const {data: assignment,error: assignmentErr}=await supabase.from(table).select("id,organization_id").eq("agent_id",agentId).match(target).eq("enabled",true).maybeSingle();
      const {data: deviceOrg}=await supabase.from(concentrador_id ? "concentradores":"rbs").select("organization_id").eq("id",concentrador_id ?? rbs_id).maybeSingle();
      const {data: owner}=await supabase.from("agents").select("organization_id").eq("id",agentId).maybeSingle();
      if(assignmentErr || !assignment || assignment.organization_id !== owner?.organization_id || deviceOrg?.organization_id !== owner?.organization_id) {errors.push("Alvo não autorizado para este agente/empresa");continue;}
    }
    if(isApi) {
      // RouterOS .id is not SNMP ifIndex. Store a separate photo, never delta/bps.
      if(concentrador_id) {
        const {error}=await supabase.from("concentradores").update({api_interfaces_snapshot:{collected_at:collectedAt,interfaces:dev.interfaces ?? []}}).eq("id",concentrador_id);
        if(error) errors.push(error.message);
      }
      continue;
    }
    // Legacy source-less payloads are quarantined: cannot claim SNMP success or mix counters.
    if(body.source !== "snmp") {errors.push("Atualize noc-agent: payload sem identificação de fonte");continue;}
    if(dev.interfaces?.some((i)=>!Number.isInteger(i.if_index) || i.if_index<=0)) {errors.push("ifIndex SNMP inválido");continue;}
    const valid=dev.snmp_valid === true && !dev.snmp_error && typeof dev.uptime_seconds === "number" && Number.isFinite(dev.uptime_seconds);
    const table=concentrador_id ? "concentradores":"rbs";
    const targetId=concentrador_id ?? rbs_id;
    const {data: previous,error: prevErr}=await supabase.from(table).select(concentrador_id ? "snmp_status,snmp_last_attempt_at,snmp_last_success_at,offline_since" : "snmp_status,snmp_last_attempt_at,snmp_last_success_at").eq("id",targetId).maybeSingle();
    // RBS has no legacy offline_since; use its own source timestamps below.
    if((previous as any)?.snmp_last_attempt_at && collectedAt <= (previous as any).snmp_last_attempt_at) continue;
    if(prevErr && concentrador_id) {errors.push(prevErr.message);continue;}
    const errText=valid ? null : dev.snmp_error ?? "SNMP sem resposta de sistema válida";
    const patch:Record<string,unknown>={snmp_last_attempt_at:collectedAt,snmp_last_error:errText,snmp_status:valid ? "online":"unreachable",status:valid ? "online":"unknown"};
    if(valid) patch.snmp_last_success_at=collectedAt;
    if(concentrador_id) {
      patch.last_collect_attempt_at=collectedAt;patch.last_collect_error=errText;
      patch.offline_since=valid ? null : previous?.snmp_status === "unreachable" ? (previous as any)?.offline_since ?? collectedAt : collectedAt;
      if(valid) {patch.ultima_coleta=collectedAt;patch.cpu_load=dev.cpu_load ?? null;patch.memory_used_pct=dev.memory_used_pct ?? null;patch.uptime_seconds=dev.uptime_seconds;}
    } else if(valid) patch.ultima_coleta=collectedAt;
    const {error: healthErr}=await supabase.from(table).update(patch).eq("id",targetId);
    if(healthErr) {errors.push(healthErr.message);continue;}
    const {error: credErr}=await supabase.from("snmp_credentials").update({last_poll_at:collectedAt,last_error:errText}).match(target);
    if(credErr) errors.push(credErr.message);
    if(concentrador_id && previous && ((valid && previous.snmp_status==="unreachable") || (!valid && previous.snmp_status==="online"))) {
      const {error: eventErr}=await supabase.from("eventos").insert({tipo:valid ? "device_up":"device_down",concentrador_id,created_at:collectedAt,descricao:valid ? "Monitoramento SNMP recuperado":"SNMP indisponível; equipamento desligado não confirmado",metadata:{source:"snmp",scope:"monitoring",offline_since:(previous as any).offline_since ?? collectedAt,recovered_at:valid ? collectedAt:null}});
      if(eventErr) errors.push(eventErr.message);
    }
    if(!valid) continue;

    // Métricas globais
    const pushMetric = (kind: string, value: number | null | undefined) => {
      if (value == null || !Number.isFinite(value)) return;
      samples.push({ collected_at: collectedAt, kind, value, ...target });
    };
    pushMetric("cpu_load", dev.cpu_load);
    pushMetric("memory_used_pct", dev.memory_used_pct);
    pushMetric("uptime_seconds", dev.uptime_seconds);
    pushMetric("temperature_c", dev.temperature_c);
    pushMetric("ping_ms", dev.ping_ms);
    pushMetric("ping_loss_pct", dev.ping_loss_pct);

    // Interfaces
    if (dev.interfaces?.length) {
      // Carrega interfaces atuais para calcular delta
      const { data: existing } = await supabase
        .from("device_interfaces")
        .select("id, if_index, last_in_octets, last_out_octets, last_sample_at, counter_source, last_device_uptime")
        .match(target);
      const byIdx = new Map((existing ?? []).map((i) => [i.if_index, i]));

      for (const iface of dev.interfaces) {
        const prev = byIdx.get(iface.if_index);
        const upsertRow: Record<string, unknown> = {
          ...target,
          if_index: iface.if_index,
          counter_source: "snmp",
          last_device_uptime: dev.uptime_seconds,
          if_name: iface.if_name ?? null,
          if_descr: iface.if_descr ?? null,
          if_alias: iface.if_alias ?? null,
          if_speed_bps: iface.if_speed_bps ?? null,
          oper_status: iface.oper_status ?? null,
          admin_status: iface.admin_status ?? null,
          last_in_octets: iface.in_octets ?? null,
          last_out_octets: iface.out_octets ?? null,
          last_sample_at: collectedAt,
        };

        // Upsert (precisa do id para FK em metric_samples). Usa onConflict no índice único parcial.
        const { data: up, error: upErr } = await supabase
          .from("device_interfaces")
          .upsert(upsertRow, {
            onConflict: concentrador_id ? "concentrador_id,if_index" : "rbs_id,if_index",
          })
          .select("id")
          .single();

        if (upErr || !up) {
          errors.push(`iface ${iface.if_index}: ${upErr?.message ?? "upsert falhou"}`);
          continue;
        }
        interfacesUpserted++;
        const interface_id = up.id;

        // Status (1=up, 2=down) como métrica numérica
        if (iface.oper_status) {
          samples.push({
            collected_at: collectedAt,
            kind: "if_oper_status",
            value: iface.oper_status === "up" ? 1 : 0,
            interface_id,
            ...target,
          });
        }

        // Calcula bps via delta de octets (somente se temos amostra anterior recente)
        if (
          prev?.counter_source === "snmp" &&
          prev.last_device_uptime != null && dev.uptime_seconds != null && dev.uptime_seconds >= Number(prev.last_device_uptime) &&
          prev?.last_sample_at &&
          prev.last_in_octets != null &&
          prev.last_out_octets != null &&
          iface.in_octets != null &&
          iface.out_octets != null
        ) {
          const prevMs = new Date(prev.last_sample_at as string).getTime();
          const dtSec = (collectedAtMs - prevMs) / 1000;
          if (dtSec > 0 && dtSec < 600) {
            // Trata wrap-around de contador 64-bit (improvável, mas seguro)
            const inDelta = Number(iface.in_octets) - Number(prev.last_in_octets);
            const outDelta = Number(iface.out_octets) - Number(prev.last_out_octets);
            if (inDelta >= 0) {
              samples.push({
                collected_at: collectedAt,
                kind: "if_in_bps",
                value: (inDelta * 8) / dtSec,
                interface_id,
                ...target,
              });
            }
            if (outDelta >= 0) {
              samples.push({
                collected_at: collectedAt,
                kind: "if_out_bps",
                value: (outDelta * 8) / dtSec,
                interface_id,
                ...target,
              });
            }
          }
        }

        if (typeof iface.in_errors === "number") {
          samples.push({ collected_at: collectedAt, kind: "if_in_errors", value: iface.in_errors, interface_id, ...target });
        }
        if (typeof iface.out_errors === "number") {
          samples.push({ collected_at: collectedAt, kind: "if_out_errors", value: iface.out_errors, interface_id, ...target });
        }
      }
    }

    if (samples.length) {
      // Insere em chunks de 500
      for (let i = 0; i < samples.length; i += 500) {
        const chunk = samples.slice(i, i + 500).map((s)=>({...s,source:"snmp"}));
        const { error } = await supabase.from("metric_samples").insert(chunk);
        if (error) errors.push(error.message);
        else samplesInserted += chunk.length;
      }
    }
  }

  if (errors.length) console.error("metrics-ingest errors:", errors.slice(0, 20));
  const devicesWithoutData = body.devices.filter((d) => !d.snmp_error && d.cpu_load == null && !d.interfaces?.length).length;
  if (devicesWithoutData) console.warn(`metrics-ingest: ${devicesWithoutData} device(s) sem nenhuma métrica no payload`);
  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      samples_inserted: samplesInserted,
      interfaces_upserted: interfacesUpserted,
      devices_without_data: devicesWithoutData,
      errors,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
