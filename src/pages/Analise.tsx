import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/MetricCard";
import { formatBytes } from "@/lib/format";
import { clientPath } from "@/lib/clientLink";
import { QueryError } from "@/components/Pager";
import { Activity, Download, Users, WifiOff } from "lucide-react";

type A24 = {
  individual_drops: number; mass_incidents: number; mass_affected: number; unstable: number;
  by_hour: { h: string; n: number }[]; top: { concentrador_id: string; username: string; n: number }[];
};

async function fetchAnalise() {
  const [an, top, sm] = await Promise.all([
    supabase.rpc("analise_24h"),
    supabase.rpc("pppoe_clients_page", { _status: "online", _sort: "traffic", _dir: "desc", _limit: 10, _offset: 0 }),
    supabase.rpc("pppoe_summary"),
  ]);
  if (an.error) throw an.error;
  if (top.error) throw top.error;
  if (sm.error) throw sm.error;
  const a = an.data as unknown as A24;
  const byHourMap = new Map(a.by_hour.map((b) => [new Date(b.h).getHours(), b.n]));
  const byHour = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(Date.now() - (23 - i) * 3600_000);
    return { hora: `${String(t.getHours()).padStart(2, "0")}h`, quedas: byHourMap.get(t.getHours()) ?? 0 };
  });
  const topQuedas = a.top.map((t) => ({ key: `${t.concentrador_id}|${t.username}`, concentrador_id: t.concentrador_id, username: t.username, quedas: t.n }));
  const topBanda = (top.data ?? [])
    .map((s) => ({ key: s.id, concentrador_id: s.concentrador_id, username: s.username, down: s.bytes_in ?? 0, up: s.bytes_out ?? 0, total: (s.bytes_in ?? 0) + (s.bytes_out ?? 0) }))
    .filter((s) => s.total > 0);
  const summ = sm.data as { online_fresh: number };
  return { byHour, topQuedas, topBanda, totalQuedas: a.individual_drops, mass: a.mass_incidents, massAffected: a.mass_affected, instaveis: a.unstable, online: summ.online_fresh };
}

export default function Analise() {
  const { data } = useQuery({ queryKey: ["analise"], queryFn: fetchAnalise, refetchInterval: 30000 });
  const gb = (v: number) => +(v / 1024 ** 3).toFixed(2);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Análise de Clientes</h1>
        <p className="text-sm text-muted-foreground">Quedas e consumo de banda nas últimas 24 horas</p>
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Clientes online" value={data?.online ?? 0} icon={<Users className="h-4 w-4" />} tone="online" />
        <MetricCard label="Quedas 24h" value={data?.totalQuedas ?? 0} icon={<WifiOff className="h-4 w-4" />} tone="offline" />
        <MetricCard label="Clientes instáveis (3+)" value={data?.instaveis ?? 0} icon={<Activity className="h-4 w-4" />} tone="warning" />
        <MetricCard label="Maior consumo" value={data?.topBanda[0] ? formatBytes(data.topBanda[0].total) : "—"} icon={<Download className="h-4 w-4" />} tone="primary" />
      </div>

      <Card className="p-4">
        <h2 className="mb-3 font-medium">Quedas por hora</h2>
        <div className="h-64">
          <ResponsiveContainer>
            <BarChart data={data?.byHour ?? []}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="hora" stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <YAxis allowDecimals={false} stroke="hsl(var(--muted-foreground))" fontSize={11} />
              <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))" }} />
              <Bar dataKey="quedas" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 font-medium">Top 10 — mais desconexões</h2>
          {data?.topQuedas.length ? (
            <div className="h-72">
              <ResponsiveContainer>
                <BarChart data={data.topQuedas} layout="vertical" margin={{ left: 40 }}>
                  <XAxis type="number" allowDecimals={false} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis type="category" dataKey="username" width={110} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))" }} />
                  <Bar dataKey="quedas" fill="hsl(var(--destructive))" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : <p className="text-sm text-muted-foreground">Nenhuma queda nas últimas 24h.</p>}
          <ul className="mt-3 space-y-1 text-sm">
            {data?.topQuedas.map((c) => (
              <li key={c.username} className="flex justify-between">
                <Link to={`/pppoe/${encodeURIComponent(c.username)}`} className="hover:underline">{c.username}</Link>
                <span className="font-mono text-destructive">{c.quedas}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-4">
          <h2 className="mb-3 font-medium">Top 10 — maior consumo de banda (sessão atual)</h2>
          {data?.topBanda.length ? (
            <>
              <div className="h-72">
                <ResponsiveContainer>
                  <BarChart data={data.topBanda.map((b) => ({ ...b, downGB: gb(b.down), upGB: gb(b.up) }))} layout="vertical" margin={{ left: 40 }}>
                    <XAxis type="number" unit=" GB" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <YAxis type="category" dataKey="username" width={110} stroke="hsl(var(--muted-foreground))" fontSize={11} />
                    <Tooltip contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))" }} />
                    <Bar dataKey="downGB" name="Download" stackId="a" fill="hsl(var(--primary))" />
                    <Bar dataKey="upGB" name="Upload" stackId="a" fill="hsl(var(--accent))" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {data.topBanda.map((c) => (
                  <li key={c.username} className="flex justify-between">
                    <Link to={`/pppoe/${encodeURIComponent(c.username)}`} className="hover:underline">{c.username}</Link>
                    <span className="font-mono">{formatBytes(c.total)}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="text-sm text-muted-foreground">Aguardando o coletor atualizado enviar o consumo de cada cliente.</p>}
        </Card>
      </div>
    </div>
  );
}
