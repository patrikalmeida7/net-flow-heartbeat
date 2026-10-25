import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { formatBytes, formatUptime, timeAgo } from "@/lib/format";

const KEY = ["pppoe"] as const;
const DROPS_KEY = ["pppoe-drops-24h"] as const;

type SortKey = "username" | "ip" | "uptime" | "drops";
type SortDir = "asc" | "desc";

function ipToNum(ip: string | null): number {
  if (!ip) return -1;
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(isNaN)) return -1;
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

export default function PPPoE() {
  useRealtimeInvalidate("pppoe_sessions", KEY);
  useRealtimeInvalidate("eventos", DROPS_KEY);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"all" | "online" | "offline">("online");
  const [sortKey, setSortKey] = useState<SortKey>("drops");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () =>
      (await supabase.from("pppoe_sessions").select("*").order("ultima_atualizacao", { ascending: false }).limit(1000))
        .data ?? [],
  });

  const { data: drops } = useQuery({
    queryKey: DROPS_KEY,
    queryFn: async () => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data } = await supabase
        .from("eventos")
        .select("username")
        .eq("tipo", "disconnect")
        .gte("created_at", since)
        .limit(10000);
      const map = new Map<string, number>();
      for (const e of data ?? []) if (e.username) map.set(e.username, (map.get(e.username) ?? 0) + 1);
      return map;
    },
  });

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir(k === "username" || k === "ip" ? "asc" : "desc");
    }
  };

  const filtered = useMemo(() => {
    let list = data ?? [];
    if (tab === "online") list = list.filter((s) => s.online);
    if (tab === "offline") list = list.filter((s) => !s.online);
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      list = list.filter(
        (s) => s.username.toLowerCase().includes(q) || (s.ip_address ?? "").toLowerCase().includes(q),
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const d = (u: string) => drops?.get(u) ?? 0;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "username":
          return a.username.localeCompare(b.username) * dir;
        case "ip":
          return (ipToNum(a.ip_address) - ipToNum(b.ip_address)) * dir;
        case "uptime":
          return ((a.uptime_seconds ?? 0) - (b.uptime_seconds ?? 0)) * dir;
        case "drops":
          return (d(a.username) - d(b.username)) * dir || a.username.localeCompare(b.username);
      }
    });
  }, [data, drops, filter, tab, sortKey, sortDir]);

  const SortHead = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => {
    const Icon = sortKey !== k ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className={right ? "text-right" : ""}>
        <button
          type="button"
          onClick={() => toggleSort(k)}
          className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === k ? "text-foreground" : ""}`}
        >
          {label}
          <Icon className="h-3 w-3" />
        </button>
      </TableHead>
    );
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usuários PPPoE</h1>
        <p className="text-sm text-muted-foreground">Sessões coletadas dos concentradores</p>
      </div>

      <Card className="bg-gradient-card p-4 shadow-card">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <TabsList>
              <TabsTrigger value="online">Online</TabsTrigger>
              <TabsTrigger value="offline">Offline</TabsTrigger>
              <TabsTrigger value="all">Todos</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative md:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar por login ou IP…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-9"
            />
          </div>
        </div>
      </Card>

      <Card className="bg-gradient-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead k="username" label="Login" />
              <SortHead k="ip" label="IP" />
              <TableHead>Interface</TableHead>
              <SortHead k="uptime" label="Uptime" right />
              <SortHead k="drops" label="Quedas 24h" right />
              <TableHead className="text-right">↓ Down</TableHead>
              <TableHead className="text-right">↑ Up</TableHead>
              <TableHead>Conectado</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice(0, 200).map((s) => {
              const n = drops?.get(s.username) ?? 0;
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-mono text-xs font-medium"><Link to={`/pppoe/${encodeURIComponent(s.username)}`} className="text-primary hover:underline">{s.username}</Link></TableCell>
                  <TableCell className="font-mono text-xs">{s.ip_address ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s.interface ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{formatUptime(s.uptime_seconds)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    <span
                      className={
                        n >= 3
                          ? "rounded-full bg-status-offline/15 px-2 py-0.5 font-semibold text-status-offline"
                          : n > 0
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }
                    >
                      {n}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{formatBytes(s.bytes_in)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{formatBytes(s.bytes_out)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(s.conectado_em)}</TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        s.online
                          ? "bg-status-online/15 text-status-online"
                          : "bg-status-offline/15 text-status-offline"
                      }`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {s.online ? "Online" : "Offline"}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  Nenhuma sessão encontrada.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {filtered.length > 200 && (
          <div className="border-t border-border p-2 text-center text-xs text-muted-foreground">
            Exibindo 200 de {filtered.length} sessões.
          </div>
        )}
      </Card>
    </div>
  );
}
