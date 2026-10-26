// Lógica pura da dashboard personalizável (testada em src/test/dashboardLogic.test.ts).
export type Viz = "number" | "gauge" | "state" | "line" | "area";
export type MetricKind = "cpu_load" | "memory_used_pct" | "uptime_seconds" | "temperature_c" | "if_traffic" | "if_oper_status" | "if_errors" | "collect_health" | "clients";
export type Panel = {
  id: string; title: string; viz: Viz; metric: MetricKind;
  concentrador_id?: string | null; rbs_id?: string | null; interface_id?: string | null;
  color?: string; decimals?: number; unit?: string; legend?: boolean;
  warn?: number | null; crit?: number | null; w: 1 | 2 | 3 | 4; h: 1 | 2;
};
export const PERIODS = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 } as const;
export const FRESH_SECONDS = 120;

/** Métrica → kinds gravados em metric_samples. */
export function kindsFor(m: MetricKind): string[] {
  switch (m) {
    case "if_traffic": return ["if_in_bps", "if_out_bps"];
    case "if_errors": return ["if_in_errors", "if_out_errors"];
    case "collect_health": case "clients": return [];
    default: return [m];
  }
}
export const needsInterface = (m: MetricKind) => m.startsWith("if_");

export type Freshness = "fresh" | "stale" | "no_sample" | "unsupported" | "error" | "loading";
export function freshness(o: { loading?: boolean; error?: boolean; supported: boolean; lastAt: string | null; now?: number }): Freshness {
  if (o.loading) return "loading";
  if (o.error) return "error";
  if (!o.supported) return "unsupported";
  if (!o.lastAt) return "no_sample";
  return ((o.now ?? Date.now()) - new Date(o.lastAt).getTime()) / 1000 <= FRESH_SECONDS ? "fresh" : "stale";
}
export const FRESH_LABEL: Record<Freshness, string> = {
  fresh: "Atual", stale: "Atrasado (último valor conhecido)", no_sample: "Sem amostra no período",
  unsupported: "Não suportado / não observado", error: "Erro na consulta", loading: "Carregando",
};

export function fmtValue(metric: MetricKind, v: number | null | undefined, decimals = 1, unit?: string): string {
  if (v == null || !Number.isFinite(v)) return "Sem dados";
  if (metric === "uptime_seconds") {
    const d = Math.floor(v / 86400), h = Math.floor((v % 86400) / 3600), m = Math.floor((v % 3600) / 60);
    return d ? `${d}d ${h}h` : `${h}h ${m}m`;
  }
  if (metric === "if_traffic") return fmtBps(v, decimals);
  if (metric === "cpu_load" || metric === "memory_used_pct") return `${v.toFixed(decimals)}%`;
  if (metric === "temperature_c") return `${v.toFixed(decimals)} °C`;
  if (metric === "if_oper_status") return v >= 1 ? "UP" : "DOWN";
  return `${v.toFixed(decimals)}${unit ? " " + unit : ""}`;
}
export function fmtBps(v: number, decimals = 1): string {
  const u = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"]; let i = 0;
  while (Math.abs(v) >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(decimals)} ${u[i]}`;
}
export function fmtVolume(bytes: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (bytes >= 1000 && i < u.length - 1) { bytes /= 1000; i++; }
  return `${bytes.toFixed(2)} ${u[i]}`;
}

export type Pt = { bucket_at: string; kind: string; avg_value: number; max_value: number; samples: number; bucket_seconds: number };
/** Pico (usa max do bucket), média ponderada por amostras, volume aproximado (só para taxas bps). */
export function stats(points: Pt[], kind: string, isRate: boolean) {
  const p = points.filter((x) => x.kind === kind);
  if (!p.length) return null;
  let peak = p[0], sum = 0, n = 0, bytes = 0;
  for (const x of p) {
    if (x.max_value > peak.max_value) peak = x;
    sum += x.avg_value * x.samples; n += x.samples;
    if (isRate) bytes += (x.avg_value / 8) * x.bucket_seconds;
  }
  return { peak: peak.max_value, peakAt: peak.bucket_at, avg: n ? sum / n : null, volumeBytes: isRate ? bytes : null, last: p[p.length - 1], buckets: p.length };
}

export function defaultPanels(concentrador_id: string | null, interface_id: string | null): Panel[] {
  const base = { concentrador_id, decimals: 1, legend: true } as const;
  const id = () => crypto.randomUUID();
  return [
    { ...base, id: id(), title: "CPU", viz: "gauge", metric: "cpu_load", w: 1, h: 1, warn: 70, crit: 90 },
    { ...base, id: id(), title: "Memória", viz: "gauge", metric: "memory_used_pct", w: 1, h: 1, warn: 80, crit: 95 },
    { ...base, id: id(), title: "Uptime", viz: "number", metric: "uptime_seconds", w: 1, h: 1 },
    { ...base, id: id(), title: "Saúde da coleta", viz: "state", metric: "collect_health", w: 1, h: 1 },
    { ...base, id: id(), title: "Temperatura", viz: "number", metric: "temperature_c", w: 1, h: 1 },
    { ...base, id: id(), title: "Clientes conectados", viz: "number", metric: "clients", w: 1, h: 1 },
    { ...base, id: id(), title: "Link principal RX/TX", viz: "area", metric: "if_traffic", interface_id, w: 4, h: 2 },
  ];
}
