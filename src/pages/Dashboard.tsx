import { useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, Radio, Server, Users, WifiOff } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { MetricCard } from "@/components/MetricCard";
import { StatusBadge } from "@/components/StatusBadge";
import { Card } from "@/components/ui/card";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { timeAgo } from "@/lib/format";
import { DashboardVpnCard } from "@/components/DashboardVpnCard";
import { Button } from "@/components/ui/button";
import { useCollectionHealth } from "@/components/CollectionHealthBadge";
import { healthLabel } from "@/lib/collectionHealth";

const KEY_DASH = ["dashboard"] as const;

type Summary = {
  snapshot_online: number | null;
  online_now: number | null;
  online_stale: number;
  last_session_update: string | null;
  disconnected_24h_clients: number;
  mass_incidents_24h: number;
  last_collect_at: string | null;
};

async function fetchDashboard() {
  const [conc, rbs, summary, history, alerts, events] = await Promise.all([
    supabase.from("concentradores").select("*").order("nome"),
    supabase.from("rbs").select("*").order("nome"),
    supabase.rpc("dashboard_summary"),
    supabase.rpc("connection_history", { _hours: 24 }),
    supabase.from("alertas").select("*").eq("status", "active").order("created_at", { ascending: false }),
    supabase.from("eventos").select("*").order("created_at", { ascending: false }).limit(8),
  ]);
  const err = conc.error || rbs.error || summary.error || history.error || alerts.error || events.error;
  if (err) throw err;
  return {
    concentradores: conc.data ?? [],
    rbs: rbs.data ?? [],
    summary: summary.data as unknown as Summary,
    history: (history.data ?? []).map((h) => ({
      time: new Date(h.bucket_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      online: Number(h.online),
    })),
    alertas: alerts.data ?? [],
    eventos: events.data ?? [],
  };
}

const sevRank = { critical: 0, warning: 1, info: 2 } as const;

export default function Dashboard() {
  useRealtimeInvalidate("concentradores", KEY_DASH);
  useRealtimeInvalidate("rbs", KEY_DASH);
  useRealtimeInvalidate("alertas", KEY_DASH);

  const { data, isError, refetch } = useQuery({ queryKey: KEY_DASH, queryFn: fetchDashboard, refetchInterval: 15000 });
  const health = useCollectionHealth();

  const totalOnline = data?.summary?.snapshot_online;
  const concOnline = (data?.concentradores ?? []).filter((c) => c.status === "online").length;
  const concOffline = (data?.concentradores ?? []).filter((c) => c.status === "offline").length;
  const rbsOnline = (data?.rbs ?? []).filter((r) => r.status === "online").length;
  const rbsOffline = (data?.rbs ?? []).filter((r) => r.status === "offline").length;
  const alertasCriticos = (data?.alertas ?? []).filter((a) => a.severidade === "critical").length;
  const attention = [...(data?.alertas ?? [])].sort(
    (a, b) => sevRank[a.severidade] - sevRank[b.severidade] || a.created_at.localeCompare(b.created_at),
  );
  const series = data?.history ?? [];

  if (isError) {
    return (
      <Card className="p-6 text-center">
        <p className="mb-3 text-sm">Não foi possível carregar a dashboard.</p>
        <Button variant="outline" onClick={() => refetch()}>Tentar novamente</Button>
      </Card>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard NOC</h1>
        <p className="text-sm text-muted-foreground">SNMP exclusivo · PPPoE: último registro via API (coleta automática desativada)</p>
      </div>

      {/* Métricas principais */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="PPPoE · último registro via API"
          value={data ? totalOnline?.toLocaleString("pt-BR") ?? "Sem dados" : "—"}
          tone={(data?.summary?.online_stale ?? 0) > 0 ? "warning" : "online"}
          icon={<Users className="h-5 w-5" />}
          hint={`último registro via API ${timeAgo(data?.summary?.last_session_update ?? null)} · tempo real indisponível`}
        />
        <MetricCard
          label="Concentradores"
          value={`${concOnline}/${(data?.concentradores ?? []).length}`}
          tone={concOffline > 0 ? "offline" : "online"}
          icon={<Server className="h-5 w-5" />}
          hint={concOffline > 0 ? `${concOffline} offline` : health.state === "ok" ? "SNMP recente" : "Sem confirmação recente"}
        />
        <MetricCard
          label="RBS / Torres"
          value={`${rbsOnline}/${(data?.rbs ?? []).length}`}
          tone={rbsOffline > 0 ? "offline" : "online"}
          icon={<Radio className="h-5 w-5" />}
          hint={rbsOffline > 0 ? `${rbsOffline} offline` : "Consulte o frescor por equipamento"}
        />
        <MetricCard
          label="Alertas ativos"
          value={(data?.alertas ?? []).length}
          tone={alertasCriticos > 0 ? "offline" : (data?.alertas ?? []).length > 0 ? "warning" : "online"}
          icon={<AlertTriangle className="h-5 w-5" />}
          hint={alertasCriticos > 0 ? `${alertasCriticos} críticos` : "Sem incidentes graves"}
        />
      </div>

      {/* Gráfico + alertas */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="bg-gradient-card p-5 shadow-card lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Conexões PPPoE — últimas 24 horas
              </h2>
              <p className="text-xs text-muted-foreground">Fotografias API de 6h; pontos antigos preservados, sem inferir quedas</p>
            </div>
            <Activity className="h-4 w-4 text-primary" />
          </div>
          <div className="h-64">
            {series.length < 2 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Histórico em formação
              </div>
            ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Area type="monotone" dataKey="online" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#g1)" />
              </AreaChart>
            </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="bg-gradient-card p-5 shadow-card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Alertas ativos</h2>
            <AlertTriangle className="h-4 w-4 text-status-warning" />
          </div>
          <div className="space-y-2">
            {(data?.alertas ?? []).length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">Nenhum alerta ativo 🎉</p>
            )}
            {attention.slice(0, 6).map((a) => (
              <div
                key={a.id}
                className={`rounded-md border p-3 text-sm ${
                  a.severidade === "critical"
                    ? "border-severity-critical/40 bg-severity-critical/10"
                    : a.severidade === "warning"
                      ? "border-severity-warning/40 bg-severity-warning/10"
                      : "border-severity-info/40 bg-severity-info/10"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">{a.titulo}</div>
                  <span className="text-[10px] text-muted-foreground">{timeAgo(a.created_at)}</span>
                </div>
                {a.descricao && <div className="mt-1 text-xs text-muted-foreground">{a.descricao}</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* VPNs + status devices */}
      <DashboardVpnCard />

      {/* Status devices */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="bg-gradient-card p-5 shadow-card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Concentradores</h2>
          <div className="space-y-2">
            {(data?.concentradores ?? []).map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded-md border border-border bg-secondary/40 p-3">
                <div className="min-w-0">
                  <div className="font-medium">{c.nome}</div>
                  <div className="font-mono text-xs text-muted-foreground">{c.host} • {c.modelo ?? "—"}</div>
                  {(() => {
                    const dh = health.devices.find((d) => d.id === c.id);
                    if (!dh || dh.state === "ok") return null;
                    return (
                      <div className="text-xs text-status-warning">
                        {healthLabel[dh.state]} · dado válido {c.snmp_last_success_at ? timeAgo(c.snmp_last_success_at) : "nunca"}
                        {c.offline_since ? ` · indisponível desde ${new Date(c.offline_since).toLocaleTimeString("pt-BR")}` : ""}
                        {c.last_collect_error ? ` · ${c.last_collect_error}` : ""}
                      </div>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.api_last_success_at ? `${c.usuarios_online} usr (foto API)` : "PPPoE sem dados"}
                  </span>
                  <StatusBadge status={health.devices.find((d)=>d.id===c.id)?.state === "ok" ? "online" : "unknown"} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="bg-gradient-card p-5 shadow-card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">RBS / Torres</h2>
          <div className="space-y-2">
            {(data?.rbs ?? []).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-md border border-border bg-secondary/40 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    {r.status === "offline" && <WifiOff className="h-3.5 w-3.5 text-status-offline" />}
                    {r.nome}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {r.ping_ms != null ? `${r.ping_ms}ms` : "—"} • perda {r.perda_pct ?? 0}%
                  </div>
                </div>
                <StatusBadge status={r.status} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
