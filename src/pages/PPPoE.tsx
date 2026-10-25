import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatUptime, timeAgo } from "@/lib/format";
import { clientPath, pageInfo, PAGE_SIZE } from "@/lib/clientLink";
import { Pager, QueryError } from "@/components/Pager";

type SortKey = "username" | "ip" | "uptime" | "drops" | "traffic";
type SortDir = "asc" | "desc";

export default function PPPoE() {
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"all" | "online" | "offline">("online");
  const [sortKey, setSortKey] = useState<SortKey>("drops");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(filter.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  const q = useQuery({
    queryKey: ["pppoe-page", search, tab, sortKey, sortDir, page],
    placeholderData: keepPreviousData,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pppoe_clients_page", {
        _search: search || null, _status: tab, _sort: sortKey, _dir: sortDir, _limit: PAGE_SIZE, _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  const summary = useQuery({
    queryKey: ["pppoe-summary"],
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("pppoe_summary");
      if (error) throw error;
      return data as { clients: number; session_records: number; online_fresh: number; online_stale: number };
    },
  });

  const rows = q.data ?? [];
  const total = Number(rows[0]?.total_count ?? 0);
  const pi = pageInfo(total, page);

  const toggleSort = (k: SortKey) => {
    setPage(0);
    if (sortKey === k) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir(k === "username" || k === "ip" ? "asc" : "desc"); }
  };

  const SortHead = ({ k, label, right }: { k: SortKey; label: string; right?: boolean }) => {
    const Icon = sortKey !== k ? ArrowUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className={right ? "text-right" : ""}>
        <button type="button" onClick={() => toggleSort(k)}
          className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === k ? "text-foreground" : ""}`}>
          {label}<Icon className="h-3 w-3" />
        </button>
      </TableHead>
    );
  };

  const s = summary.data;
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Usuários PPPoE</h1>
        <p className="text-sm text-muted-foreground">
          {s
            ? `${s.clients.toLocaleString("pt-BR")} clientes únicos · ${s.session_records.toLocaleString("pt-BR")} registros de sessão no histórico · ${s.online_fresh} online confirmados${s.online_stale ? ` · ${s.online_stale} sem atualização há +5 min` : ""}`
            : summary.isError ? "Não foi possível carregar os totais." : "Carregando totais…"}
        </p>
      </div>

      <Card className="bg-gradient-card p-4 shadow-card">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Tabs value={tab} onValueChange={(v) => { setTab(v as typeof tab); setPage(0); }}>
            <TabsList>
              <TabsTrigger value="online">Online</TabsTrigger>
              <TabsTrigger value="offline">Offline</TabsTrigger>
              <TabsTrigger value="all">Todos</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative md:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Buscar por login ou IP…" value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-9" />
          </div>
        </div>
      </Card>

      <Card className="bg-gradient-card shadow-card">
        {q.isError ? <QueryError onRetry={() => q.refetch()} what="os clientes" /> : (
        <>
        <Table>
          <TableHeader>
            <TableRow>
              <SortHead k="username" label="Login" />
              <TableHead>Concentrador</TableHead>
              <SortHead k="ip" label="IP" />
              <SortHead k="uptime" label="Uptime" right />
              <SortHead k="drops" label="Quedas 24h" right />
              <SortHead k="traffic" label="↓ Down" right />
              <TableHead className="text-right">↑ Up</TableHead>
              <TableHead>Atualizado</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const n = Number(r.drops_24h);
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs font-medium">
                    <Link to={clientPath(r.concentrador_id, r.username)} className="text-primary hover:underline">{r.username}</Link>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.concentrador_nome ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{r.ip_address ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{r.online ? formatUptime(r.uptime_seconds) : "—"}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    <span className={n >= 3 ? "rounded-full bg-status-offline/15 px-2 py-0.5 font-semibold text-status-offline" : n > 0 ? "text-foreground" : "text-muted-foreground"}>{n}</span>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{r.bytes_in ? formatBytes(r.bytes_in) : "Sem dados"}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{r.bytes_out ? formatBytes(r.bytes_out) : "Sem dados"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{timeAgo(r.ultima_atualizacao)}</TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      r.stale ? "bg-status-warning/15 text-status-warning" : r.online ? "bg-status-online/15 text-status-online" : "bg-status-offline/15 text-status-offline"}`}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      {r.stale ? "Último estado: online" : r.online ? "Online" : "Offline"}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  {q.isLoading ? "Carregando…" : "Nenhum cliente encontrado."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <Pager total={total} {...pi} onPage={setPage} unit="clientes" />
        </>)}
      </Card>
    </div>
  );
}
