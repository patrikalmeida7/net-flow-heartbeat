import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { formatBytes, formatUptime, timeAgo } from "@/lib/format";

const KEY = ["pppoe"] as const;

export default function PPPoE() {
  useRealtimeInvalidate("pppoe_sessions", KEY);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"all" | "online" | "offline">("online");

  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () =>
      (await supabase.from("pppoe_sessions").select("*").order("ultima_atualizacao", { ascending: false }).limit(500))
        .data ?? [],
  });

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
    return list;
  }, [data, filter, tab]);

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
              <TableHead>Login</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Interface</TableHead>
              <TableHead className="text-right">Uptime</TableHead>
              <TableHead className="text-right">↓ Down</TableHead>
              <TableHead className="text-right">↑ Up</TableHead>
              <TableHead>Conectado</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.slice(0, 200).map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs font-medium">{s.username}</TableCell>
                <TableCell className="font-mono text-xs">{s.ip_address ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{s.interface ?? "—"}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatUptime(s.uptime_seconds)}</TableCell>
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
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
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
