import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Maximize2, Copy, Trash2, Settings2, GripVertical } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { timeAgo } from "@/lib/format";
import { FRESH_LABEL, fmtValue, fmtVolume, freshness, kindsFor, needsInterface, stats, type Panel, type Pt } from "@/lib/dashboardLogic";

export type Device = { id: string; nome: string; type: "conc" | "rbs"; snmp_status: string | null; snmp_last_success_at: string | null };
type Range = { since: string; until: string };

export function useSeries(p: Panel, deviceId: string | null, dev: Device | undefined, range: Range, refreshMs: number | false) {
  const kinds = kindsFor(p.metric);
  const conc = dev?.type === "conc" ? deviceId : null, rbs = dev?.type === "rbs" ? deviceId : null;
  const iface = needsInterface(p.metric) ? p.interface_id ?? null : null;
  // Chave compartilhada: painéis do mesmo equipamento/interface/período reaproveitam a consulta
  return useQuery({
    queryKey: ["dash-series", conc, rbs, iface, kinds.join(","), range.since, range.until],
    enabled: !!deviceId && kinds.length > 0 && (!needsInterface(p.metric) || !!iface),
    refetchInterval: refreshMs,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("metric_series", { _concentrador: conc, _rbs: rbs, _interface: iface, _kinds: kinds, _since: range.since, _until: range.until, _points: 240 });
      if (error) throw error;
      return (data ?? []) as Pt[];
    },
  });
}

const COLORS = { in: "hsl(var(--primary))", out: "hsl(var(--status-warning, 38 92% 50%))" };

function Gauge({ value, warn, crit }: { value: number | null; warn?: number | null; crit?: number | null }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const a = Math.PI * (1 - v / 100), x = 50 + 40 * Math.cos(a), y = 50 - 40 * Math.sin(a);
  const tone = value == null ? "hsl(var(--muted-foreground))" : crit != null && v >= crit ? "hsl(var(--destructive))" : warn != null && v >= warn ? "hsl(38 92% 50%)" : "hsl(var(--primary))";
  return (
    <svg viewBox="0 0 100 56" className="mx-auto w-full max-w-[160px]">
      <path d="M10 50 A40 40 0 0 1 90 50" fill="none" stroke="hsl(var(--muted))" strokeWidth="8" />
      {value != null && <path d={`M10 50 A40 40 0 0 1 ${x} ${y}`} fill="none" stroke={tone} strokeWidth="8" />}
    </svg>
  );
}

export function DashPanel({ p, device, deviceId, range, refreshMs, supportedAt, catalogError, edit, zoom, onEdit, onDup, onDel, onZoom, dragProps }: {
  p: Panel; device?: Device; deviceId: string | null; range: Range; refreshMs: number | false;
  supportedAt: string | null | undefined; catalogError: boolean; edit: boolean; zoom?: boolean;
  onEdit?: () => void; onDup?: () => void; onDel?: () => void; onZoom?: () => void; dragProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const q = useSeries(p, deviceId, device, range, refreshMs);
  const isRate = p.metric === "if_traffic";
  const kinds = kindsFor(p.metric);
  const pts = q.data ?? [];

  let body: React.ReactNode, lastAt: string | null = null, fr;
  if (!deviceId) { body = <p className="text-sm text-muted-foreground">Selecione um equipamento</p>; fr = "no_sample" as const; }
  else if (p.metric === "clients") { body = <p className="text-sm text-muted-foreground">Não disponível via SNMP</p>; fr = "unsupported" as const; }
  else if (p.metric === "collect_health") {
    lastAt = device?.snmp_last_success_at ?? null;
    fr = freshness({ supported: true, lastAt });
    body = <p className="text-2xl font-semibold">{fr === "fresh" ? "SNMP online" : device?.snmp_status === "unreachable" ? "SNMP indisponível" : lastAt ? "Atrasado" : "Sem dados"}</p>;
  } else if (needsInterface(p.metric) && !p.interface_id) { body = <p className="text-sm text-muted-foreground">Escolha uma interface</p>; fr = "no_sample" as const; }
  else {
    lastAt = supportedAt ?? null;
    fr = freshness({ loading: q.isLoading, error: !!q.error || catalogError, supported: supportedAt !== undefined, lastAt });
    const s0 = stats(pts, kinds[0], isRate), s1 = kinds[1] ? stats(pts, kinds[1], isRate) : null;
    const lastVal = s0?.last.avg_value ?? null;
    if (q.error) body = <div className="text-sm text-destructive">Erro na consulta <Button size="sm" variant="outline" className="ml-2" onClick={() => q.refetch()}>Tentar de novo</Button></div>;
    else if (p.viz === "line" || p.viz === "area") {
      const map = new Map<string, Record<string, number | string>>();
      for (const x of pts) { const r = map.get(x.bucket_at) ?? { t: x.bucket_at }; r[x.kind] = x.max_value; map.set(x.bucket_at, r); }
      const data = [...map.values()];
      const Chart = p.viz === "area" ? AreaChart : LineChart;
      const fmtT = (t: string) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const label = (k: string) => k.includes("in") ? "RX (entrada na interface)" : k.includes("out") ? "TX (saída da interface)" : p.title;
      body = data.length === 0 ? <p className="text-sm text-muted-foreground">Sem amostra no período</p> : (
        <>
          <div className={zoom ? "h-[60vh]" : p.h === 2 ? "h-56" : "h-28"}>
            <ResponsiveContainer>
              <Chart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="t" tickFormatter={fmtT} fontSize={10} stroke="hsl(var(--muted-foreground))" />
                <YAxis tickFormatter={(v) => fmtValue(p.metric, v, 0)} fontSize={10} width={70} stroke="hsl(var(--muted-foreground))" />
                <Tooltip formatter={(v: number) => fmtValue(p.metric, v, p.decimals)} labelFormatter={(t) => new Date(t).toLocaleString("pt-BR")} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
                {p.legend && <Legend formatter={label} />}
                {kinds.map((k, i) => p.viz === "area"
                  ? <Area key={k} dataKey={k} name={k} stroke={i ? COLORS.out : p.color || COLORS.in} fill={i ? COLORS.out : p.color || COLORS.in} fillOpacity={0.15} isAnimationActive={false} />
                  : <Line key={k} dataKey={k} name={k} stroke={i ? COLORS.out : p.color || COLORS.in} dot={false} isAnimationActive={false} />)}
              </Chart>
            </ResponsiveContainer>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground">
            {[s0, s1].map((s, i) => s && (
              <div key={i}>
                <b>{kinds.length > 1 ? (i ? "TX" : "RX") : ""}</b> pico {fmtValue(p.metric, s.peak, p.decimals)} às {new Date(s.peakAt).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })} · média {fmtValue(p.metric, s.avg, p.decimals)}
                {s.volumeBytes != null && <> · volume ≈ {fmtVolume(s.volumeBytes)}</>}
              </div>
            ))}
            <div className="col-span-2">Resolução {pts[0]?.bucket_seconds ?? "?"}s · {s0?.buckets ?? 0} pontos</div>
          </div>
        </>
      );
    } else if (p.viz === "gauge") body = <div className="text-center"><Gauge value={lastVal} warn={p.warn} crit={p.crit} /><p className="text-xl font-semibold">{fmtValue(p.metric, lastVal, p.decimals, p.unit)}</p></div>;
    else if (p.viz === "state") body = <p className="text-2xl font-semibold">{lastVal == null ? "Sem dados" : lastVal >= 1 ? "UP" : "DOWN"}</p>;
    else body = <p className="text-2xl font-semibold" style={p.color ? { color: p.color } : undefined}>{fmtValue(p.metric, lastVal, p.decimals, p.unit)}</p>;
  }

  return (
    <Card className="bg-gradient-card p-3 shadow-card h-full flex flex-col" {...dragProps}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-1 min-w-0">
          {edit && <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />}
          <span className="truncate text-sm font-medium">{p.title}</span>
        </div>
        <div className="flex shrink-0 gap-1">
          {edit ? (<>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onEdit} aria-label="Configurar"><Settings2 className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onDup} aria-label="Duplicar"><Copy className="h-3.5 w-3.5" /></Button>
            <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onDel} aria-label="Remover"><Trash2 className="h-3.5 w-3.5" /></Button>
          </>) : !zoom && <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onZoom} aria-label="Ampliar"><Maximize2 className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
      <div className="flex-1">{body}</div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <Badge variant={fr === "fresh" ? "default" : fr === "error" ? "destructive" : "secondary"} className="text-[10px]">{FRESH_LABEL[fr]}</Badge>
        <span>{lastAt ? `Última obs. ${timeAgo(lastAt)}` : ""}</span>
      </div>
    </Card>
  );
}
