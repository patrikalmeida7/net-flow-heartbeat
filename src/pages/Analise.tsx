import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { MetricCard } from "@/components/MetricCard";
import { formatBytes } from "@/lib/format";
import { Activity, Download, Users, WifiOff } from "lucide-react";

async function fetchAnalise() {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const [ev, sess] = await Promise.all([
    supabase.from("eventos").select("username, created_at").eq("tipo", "disconnect").gte("created_at", since).limit(10000),
    supabase.from("pppoe_sessions").select("username, ip_address, bytes_in, bytes_out, online").eq("online", true).limit(10000),
  ]);
  const events = ev.data ?? [];
  const sessions = sess.data ?? [];

  const byHour = Array.from({ length: 24 }, (_, i) => {
    const t = new Date(Date.now() - (23 - i) * 3600_000);
    return { key: t.getHours(), hora: `${String(t.getHours()).padStart(2, "0")}h`, quedas: 0 };
  });
  const byUser = new Map<string, number>();
  for (const e of events) {
    const h = new Date(e.created_at).getHours();
    const slot = byHour.find((b) => b.key === h);
    if (slot) slot.quedas++;
    if (e.username) byUser.set(e.username, (byUser.get(e.username) ?? 0) + 1);
  }
  const topQuedas = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([username, quedas]) => ({ username, quedas }));
  const topBanda = sessions
    .map((s) => ({ username: s.username, ip: s.ip_address, down: s.bytes_in ?? 0, up: s.bytes_out ?? 0, total: (s.bytes_in ?? 0) + (s.bytes_out ?? 0) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  const instaveis = [...byUser.values()].filter((n) => n >= 3).length;
  return { byHour, topQuedas, topBanda, totalQuedas: events.length, instaveis, online: sessions.length };
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
        <MetricCard label="Clientes online" value={data?.online ?? 0} icon={Users} />
        <MetricCard label="Quedas 24h" value={data?.totalQuedas ?? 0} icon={WifiOff} />
        <MetricCard label="Clientes instáveis (3+)" value={data?.instaveis ?? 0} icon={Activity} />
        <MetricCard label="Maior consumo" value={data?.topBanda[0] ? formatBytes(data.topBanda[0].total) : "—"} icon={Download} />
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
