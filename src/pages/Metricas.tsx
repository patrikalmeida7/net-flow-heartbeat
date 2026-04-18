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
    supabase.from("device_interfaces").select("*").order("if_index"),
    supabase.from("concentradores").select("id, nome"),
    supabase.from("rbs").select("id, nome"),
  ]);
  return {
    ifaces: (ifaces.data ?? []) as Iface[],
    concById: new Map((concs.data ?? []).map((c) => [c.id, c.nome as string])),
    rbsById: new Map((rbs.data ?? []).map((r) => [r.id, r.nome as string])),
  };
}

async function fetchInterfaceSeries(ifaceId: string) {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data } = await supabase
    .from("metric_samples")
    .select("collected_at, kind, value")
    .eq("interface_id", ifaceId)
    .in("kind", ["if_in_bps", "if_out_bps"])
    .gte("collected_at", since)
    .order("collected_at", { ascending: true })
    .limit(2000);
  return (data ?? []) as Sample[];
}

async function fetchDeviceSeries(opts: { concentrador_id?: string; rbs_id?: string }) {
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  let q = supabase
    .from("metric_samples")
    .select("collected_at, kind, value")
    .in("kind", ["cpu_load", "memory_used_pct"])
    .gte("collected_at", since)
    .order("collected_at", { ascending: true })
    .limit(2000);
  if (opts.concentrador_id) q = q.eq("concentrador_id", opts.concentrador_id);
  if (opts.rbs_id) q = q.eq("rbs_id", opts.rbs_id);
  return ((await q).data ?? []) as Sample[];
}

export default function Metricas() {
  useRealtimeInvalidate("metric_samples", KEY_BASE);
  useRealtimeInvalidate("device_interfaces", KEY_BASE);

  const { data } = useQuery({ queryKey: [...KEY_BASE, "ifaces"], queryFn: fetchInterfaces });
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

  const { data: ifaceSamples } = useQuery({
    queryKey: [...KEY_BASE, "iface", selectedIfaceId],
    queryFn: () => fetchInterfaceSeries(selectedIfaceId),
    enabled: !!selectedIfaceId,
    refetchInterval: 5000,
  });

  const { data: deviceSamples } = useQuery({
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
    const m = new Map<string, { time: string; ts: number; in_bps: number; out_bps: number }>();
    for (const s of ifaceSamples ?? []) {
      const ts = new Date(s.collected_at).getTime();
      const key = s.collected_at;
      if (!m.has(key)) {
        m.set(key, {
          time: new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          ts,
          in_bps: 0,
          out_bps: 0,
        });
      }
      const row = m.get(key)!;
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
      const row = m.get(s.collected_at)!;
      if (s.kind === "cpu_load") row.cpu = s.value;
      if (s.kind === "memory_used_pct") row.mem = s.value;
    }
    return [...m.values()].sort((a, b) => a.ts - b.ts);
  }, [deviceSamples]);

  const last = trafficSeries[trafficSeries.length - 1];
  const peakIn = trafficSeries.reduce((a, b) => Math.max(a, b.in_bps), 0);
  const peakOut = trafficSeries.reduce((a, b) => Math.max(a, b.out_bps), 0);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Métricas SNMP</h1>
        <p className="text-sm text-muted-foreground">
          Tráfego, CPU e memória em tempo real. Atualização automática via WebSocket.
        </p>
      </div>

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
            <TrendingDown className="h-3.5 w-3.5" /> Download atual
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">{formatBps(last?.in_bps ?? 0)}</div>
          <div className="text-xs text-muted-foreground">Pico (30min): {formatBps(peakIn)}</div>
        </Card>
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" /> Upload atual
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">{formatBps(last?.out_bps ?? 0)}</div>
          <div className="text-xs text-muted-foreground">Pico (30min): {formatBps(peakOut)}</div>
        </Card>
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" /> CPU
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">
            {cpuMemSeries[cpuMemSeries.length - 1]?.cpu?.toFixed(0) ?? "—"}%
          </div>
        </Card>
        <Card className="bg-gradient-card p-4 shadow-card">
          <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5" /> Memória
          </div>
          <div className="mt-2 font-mono text-2xl font-semibold">
            {cpuMemSeries[cpuMemSeries.length - 1]?.mem?.toFixed(0) ?? "—"}%
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
            <p className="text-xs text-muted-foreground">In/Out em bits/s · atualização a cada 5s</p>
          </div>
          <Activity className="h-4 w-4 text-primary" />
        </div>
        <div className="h-72">
          {trafficSeries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Sem amostras ainda. Aguardando agente coletor SNMP enviar dados…
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
                  formatter={(v: number, name: string) => [formatBps(v), name === "in_bps" ? "Download" : "Upload"]}
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
          {cpuMemSeries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Sem amostras ainda.
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
