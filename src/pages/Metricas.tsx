import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Cpu, HardDrive, TrendingDown, TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { formatBps, timeAgo } from "@/lib/format";

type Iface = {
  id: string;
  concentrador_id: string | null;
  rbs_id: string | null;
  if_index: number;
  if_name: string | null;
  if_descr: string | null;
  if_alias: string | null;
  if_speed_bps: number | null;
  oper_status: string | null;
  last_sample_at: string | null;
};

type Sample = {
  collected_at: string;
  kind: string;
  value: number;
  interface_id: string | null;
  concentrador_id: string | null;
  rbs_id: string | null;
};

const KEY_BASE = ["metricas"] as const;

async function fetchInterfaces() {
  const [ifaces, concs, rbs] = await Promise.all([
    supabase.from("device_interfaces").select("*").eq("counter_source","snmp").order("if_index"),
    supabase.from("concentradores").select("id, nome"),
    supabase.from("rbs").select("id, nome"),
  ]);
  if (ifaces.error) throw ifaces.error;
  if (concs.error) throw concs.error;
  return {
    ifaces: (ifaces.data ?? []) as Iface[],
    concById: new Map((concs.data ?? []).map((c) => [c.id, c.nome as string])),
    rbsError: rbs.error ? String(rbs.error.message) : null,
    rbsById: new Map((rbs.data ?? []).map((r) => [r.id, r.nome as string])),
  };
}

// Server-bucketed SNMP series (avg + max per bucket). Missing buckets stay absent (= "Sem dados"), never 0.
type Bucket = { bucket_at: string; kind: string; avg_value: number; max_value: number };
const toSamples = (rows: Bucket[] | null) =>
  (rows ?? []).map((r) => ({ collected_at: r.bucket_at, kind: r.kind, value: r.avg_value, max: r.max_value }));

async function fetchInterfaceSeries(ifaceId: string) {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data, error } = await supabase.rpc("metric_series", {
    _concentrador: null, _rbs: null, _interface: ifaceId,
    _kinds: ["if_in_bps", "if_out_bps"], _since: since, _points: 60,
  });
  if (error) throw error;
  return toSamples(data as Bucket[]);
}

async function fetchDeviceSeries(opts: { concentrador_id?: string; rbs_id?: string }) {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await supabase.rpc("metric_series", {
    _concentrador: opts.concentrador_id ?? null, _rbs: opts.rbs_id ?? null, _interface: null,
    _kinds: ["cpu_load", "memory_used_pct"], _since: since, _points: 120,
  });
  if (error) throw error;
  return toSamples(data as Bucket[]);
}

export default function Metricas() {
  useRealtimeInvalidate("metric_samples", KEY_BASE);
  useRealtimeInvalidate("device_interfaces", KEY_BASE);

  const ifq = useQuery({ queryKey: [...KEY_BASE, "ifaces"], queryFn: fetchInterfaces, refetchInterval: 30000 });
  const data = ifq.data;
  const ifaces = data?.ifaces ?? [];

  const [selectedIfaceId, setSelectedIfaceId] = useState<string>("");

  // Auto-seleciona a primeira interface up
  useEffect(() => {
    if (!selectedIfaceId && ifaces.length) {
      const first = ifaces.find((i) => i.oper_status === "up") ?? ifaces[0];
      setSelectedIfaceId(first.id);
    }
  }, [ifaces, selectedIfaceId]);

  const selected = ifaces.find((i) => i.id === selectedIfaceId);
  const deviceLabel = selected
    ? selected.concentrador_id
      ? data?.concById.get(selected.concentrador_id) ?? "—"
      : data?.rbsById.get(selected.rbs_id ?? "") ?? "—"
    : "—";

  const { data: ifaceSamples, isError: ifaceErr, refetch: refetchIface, isLoading: ifaceLoading } = useQuery({
    queryKey: [...KEY_BASE, "iface", selectedIfaceId],
    queryFn: () => fetchInterfaceSeries(selectedIfaceId),
    enabled: !!selectedIfaceId,
    refetchInterval: 5000,
  });

  const { data: deviceSamples, isError: devErr, refetch: refetchDev } = useQuery({
    queryKey: [...KEY_BASE, "device", selected?.concentrador_id ?? selected?.rbs_id],
    queryFn: () =>
      fetchDeviceSeries(
        selected?.concentrador_id ? { concentrador_id: selected.concentrador_id } : { rbs_id: selected?.rbs_id ?? "" },
      ),
    enabled: !!selected,
    refetchInterval: 10000,
  });

  // Pivota samples por timestamp para o gráfico
  const trafficSeries = useMemo(() => {
    const m = new Map<string, { time: string; ts: number; in_bps: number | null; out_bps: number | null }>();
    for (const s of ifaceSamples ?? []) {
      const ts = new Date(s.collected_at).getTime();
      const key = s.collected_at;
      if (!m.has(key)) {
        m.set(key, {
          time: new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          ts,
          in_bps: null,
          out_bps: null,
        });
      }
      const row = m.get(key);
      if (!row) continue;
      if (s.kind === "if_in_bps") row.in_bps = s.value;
      if (s.kind === "if_out_bps") row.out_bps = s.value;
    }
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }, [ifaceSamples]);

  const cpuMemSeries = useMemo(() => {
    const m = new Map<string, { time: string; ts: number; cpu: number | null; mem: number | null }>();
    for (const s of deviceSamples ?? []) {
      const ts = new Date(s.collected_at).getTime();
      if (!m.has(s.collected_at)) {
        m.set(s.collected_at, {
          time: new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
          ts,
          cpu: null,
          mem: null,
        });
      }
      const row = m.get(s.collected_at);
      if (!row) continue;
      if (s.kind === "cpu_load") row.cpu = s.value;
      if (s.kind === "memory_used_pct") row.mem = s.value;
    }
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }, [deviceSamples]);

  const last = trafficSeries[trafficSeries.length - 1];
  // Picos vêm do máximo de cada intervalo (não da média), para não achatar rajadas.
  const peakOf = (k: "in_bps" | "out_bps") => {
    const kind = k === "in_bps" ? "if_in_bps" : "if_out_bps";
    const v = (ifaceSamples ?? []).filter((s) => s.kind === kind).map((s) => s.max);
    return v.length ? Math.max(...v) : null;
  };
  const peakIn = peakOf("in_bps");
  const peakOut = peakOf("out_bps");
  // Frescor: amostra de tráfego mais recente vs. intervalo de coleta (~30s)
  const lastTs = last?.ts ?? null;
  const ageMs = lastTs ? Date.now() - lastTs : null;
  const fresh = ageMs == null ? "Sem dados" : ageMs > 10 * 60_000 ? "Falha de coleta" : ageMs > 2 * 60_000 ? "Dados atrasados" : "Coleta em dia";
  const showBps = (v: number | null | undefined) => (v == null ? "Sem dados" : formatBps(v));
  const lastCpu = cpuMemSeries.filter((r) => r.cpu != null).pop()?.cpu;
  const lastMem = cpuMemSeries.filter((r) => r.mem != null).pop()?.mem;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Métricas SNMP</h1>
        <p className="text-sm text-muted-foreground">
          Tráfego, CPU e memória via SNMP. Valores atrasados aparecem como último valor conhecido, com horário.
        </p>
      </div>

      {ifq.isError && (
        <Card className="p-4 text-sm">
          Erro ao carregar interfaces. <button className="text-primary underline" onClick={() => ifq.refetch()}>Tentar novamente</button>
        </Card>
      )}
      {data?.rbsError && (
        <Card className="p-4 text-sm">
          Erro ao carregar RBS; nomes podem faltar. <button className="text-primary underline" onClick={() => ifq.refetch()}>Tentar novamente</button>
        </Card>
      )}
      {!ifq.isError && !ifq.isLoading && ifaces.length === 0 && (
        <Card className="p-4 text-sm text-muted-foreground">
          Nenhuma interface recebida ainda do coletor SNMP. Tráfego aparece aqui quando a primeira amostra chegar.
        </Card>
      )}
      {selected && (
        <p className="text-xs text-muted-foreground">
          Estado do tráfego: <span className="font-medium text-foreground">{fresh}</span>
          {lastTs ? ` · última amostra ${timeAgo(new Date(lastTs).toISOString())}` : ""}
        </p>
      )}

      {/* Seletor de interface */}
      <Card className="bg-gradient-card p-4 shadow-card">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[280px] flex-1">
            <label className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">
              Interface monitorada
            </label>
            <Select value={selectedIfaceId} onValueChange={setSelectedIfaceId}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione uma interface…" />
              </SelectTrigger>
              <SelectContent>
                {ifaces.map((i) => {
                  const dev = i.concentrador_id
                    ? data?.concById.get(i.concentrador_id)
                    : data?.rbsById.get(i.rbs_id ?? "");
                  return (
                    <SelectItem key={i.id} value={i.id}>
                      {dev} · {i.if_name ?? i.if_descr ?? `if${i.if_index}`} {i.oper_status === "up" ? "🟢" : "🔴"}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          {selected && (
            <div className="text-xs text-muted-foreground">
              <div><span className="font-medium text-foreground">{deviceLabel}</span> · {selected.if_descr ?? selected.if_name}</div>
              <div>
                Velocidade: {selected.if_speed_bps ? formatBps(selected.if_speed_bps) : "—"} · Última amostra: {timeAgo(selected.last_sample_at)}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Cards de status */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <TrendingDown className="h-3.5 w-3.5" /> Entrada (RX) {fresh === "Coleta em dia" ? "atual" : "· último valor conhecido"}
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">{showBps(last?.in_bps)}</div>
          <div className="text-xs text-muted-foreground">Pico (30min): {showBps(peakIn)}</div>
        </Card>
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" /> Saída (TX) {fresh === "Coleta em dia" ? "atual" : "· último valor conhecido"}
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">{showBps(last?.out_bps)}</div>
          <div className="text-xs text-muted-foreground">Pico (30min): {showBps(peakOut)}</div>
        </Card>
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" /> CPU
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">
            {lastCpu != null ? `${lastCpu.toFixed(0)}%` : "Sem dados"}
          </div>
        </Card>
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" /> Memória
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">
            {lastMem != null ? `${lastMem.toFixed(0)}%` : "Sem dados"}
          </div>
        </Card>
      </div>

      {/* Gráfico de tráfego */}
      <Card className="bg-gradient-card p-5 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Tráfego — últimos 30 minutos
            </h2>
            <p className="text-xs text-muted-foreground">Entrada (RX) / Saída (TX) em bits/s · atualização a cada 5s</p>
          </div>
          <Activity className="h-4 w-4 text-primary" />
        </div>
        <div className="h-72">
          {ifaceErr ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
              Erro ao carregar o tráfego.
              <button className="text-primary underline" onClick={() => refetchIface()}>Tentar novamente</button>
            </div>
          ) : ifaceLoading && selectedIfaceId ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Carregando…</div>
          ) : trafficSeries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Sem amostras de tráfego nos últimos 30 minutos para esta interface.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trafficSeries}>
                <defs>
                  <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--status-online))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--status-online))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={40} />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickFormatter={(v) => formatBps(v)}
                  width={70}
                />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v: number, name: string) => [formatBps(v), name === "in_bps" ? "Entrada (RX)" : "Saída (TX)"]}
                />
                <Area type="monotone" dataKey="in_bps" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#gIn)" />
                <Area type="monotone" dataKey="out_bps" stroke="hsl(var(--status-online))" strokeWidth={2} fill="url(#gOut)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>

      {/* Gráfico CPU/Mem */}
      <Card className="bg-gradient-card p-5 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              CPU & Memória do equipamento — última hora
            </h2>
          </div>
        </div>
        <div className="h-56">
          {devErr ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm">
              Erro ao carregar CPU/memória.
              <button className="text-primary underline" onClick={() => refetchDev()}>Tentar novamente</button>
            </div>
          ) : cpuMemSeries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Sem amostras de CPU/memória na última hora.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cpuMemSeries}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={11} minTickGap={40} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} domain={[0, 100]} unit="%" width={45} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area type="monotone" dataKey="cpu" stroke="hsl(var(--severity-warning))" strokeWidth={2} fill="hsl(var(--severity-warning) / 0.2)" />
                <Area type="monotone" dataKey="mem" stroke="hsl(var(--primary))" strokeWidth={2} fill="hsl(var(--primary) / 0.15)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </Card>
    </div>
  );
}
