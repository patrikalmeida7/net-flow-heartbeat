// Recebe um lote de samples SNMP do agente local.
// - Auth via header x-agent-token (mesmo segredo de agent-ingest).
// - Resolve concentrador/rbs por host.
// - Faz upsert das interfaces (descoberta).
// - Calcula bps a partir de delta de octets quando aplicável.
// - Insere amostras em metric_samples (raw, retenção 7 dias).
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
  const got = req.headers.get("x-agent-token");
  if (!expected || got !== expected) {
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

  if (!body?.devices?.length) {
    return new Response(JSON.stringify({ error: "devices required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const collectedAt = body.collected_at ?? new Date().toISOString();
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
    const concentrador_id = dev.concentrador_host ? concByHost.get(dev.concentrador_host) ?? null : null;
    const rbs_id = dev.rbs_host ? rbsByHost.get(dev.rbs_host) ?? null : null;

    if (!concentrador_id && !rbs_id) {
      errors.push(`device sem alvo conhecido: ${dev.concentrador_host ?? dev.rbs_host ?? "?"}`);
      continue;
    }

    const target = concentrador_id ? { concentrador_id } : { rbs_id };
    const samples: Array<Record<string, unknown>> = [];

    // Atualiza erro / last_poll_at na credencial
    {
      const credFilter = concentrador_id
        ? { concentrador_id }
        : { rbs_id: rbs_id! };
      await supabase
        .from("snmp_credentials")
        .update({ last_poll_at: collectedAt, last_error: dev.snmp_error ?? null })
        .match(credFilter);
    }

    // Atualiza status básico do equipamento
    if (concentrador_id) {
      const patch: Record<string, unknown> = { ultima_coleta: collectedAt };
      if (typeof dev.cpu_load === "number") patch.cpu_load = Math.round(dev.cpu_load);
      if (typeof dev.memory_used_pct === "number") patch.memory_used_pct = Math.round(dev.memory_used_pct);
      if (typeof dev.uptime_seconds === "number") patch.uptime_seconds = Math.round(dev.uptime_seconds);
      if (!dev.snmp_error) patch.status = "online";
      else patch.status = "offline";
      await supabase.from("concentradores").update(patch).eq("id", concentrador_id);
    } else if (rbs_id) {
      const patch: Record<string, unknown> = { ultima_coleta: collectedAt };
      if (typeof dev.ping_ms === "number") patch.ping_ms = Math.round(dev.ping_ms);
      if (typeof dev.ping_loss_pct === "number") patch.perda_pct = Math.round(dev.ping_loss_pct);
      if (!dev.snmp_error) patch.status = "online";
      else patch.status = "offline";
      await supabase.from("rbs").update(patch).eq("id", rbs_id);
    }

    // Métricas globais
    const pushMetric = (kind: string, value: number | null | undefined) => {
      if (value == null || Number.isNaN(value)) return;
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
        .select("id, if_index, last_in_octets, last_out_octets, last_sample_at")
        .match(target);
      const byIdx = new Map((existing ?? []).map((i) => [i.if_index, i]));

      for (const iface of dev.interfaces) {
        const prev = byIdx.get(iface.if_index);
        const upsertRow: Record<string, unknown> = {
          ...target,
          if_index: iface.if_index,
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
        const chunk = samples.slice(i, i + 500);
        const { error } = await supabase.from("metric_samples").insert(chunk);
        if (error) errors.push(error.message);
        else samplesInserted += chunk.length;
      }
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      samples_inserted: samplesInserted,
      interfaces_upserted: interfacesUpserted,
      errors,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
