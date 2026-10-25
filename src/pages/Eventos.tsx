import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { timeAgo } from "@/lib/format";
import { clientPath, pageInfo, PAGE_SIZE } from "@/lib/clientLink";
import { Pager, QueryError } from "@/components/Pager";

const tipoLabels: Record<string, { label: string; cls: string }> = {
  connect: { label: "Conexão", cls: "bg-status-online/15 text-status-online" },
  disconnect: { label: "Queda individual", cls: "bg-muted text-muted-foreground" },
  device_down: { label: "Equipamento caiu", cls: "bg-status-offline/15 text-status-offline" },
  mass: { label: "Queda em massa", cls: "bg-status-offline/15 text-status-offline" },
  device_up: { label: "Equipamento voltou", cls: "bg-status-online/15 text-status-online" },
  rbs_down: { label: "RBS caiu", cls: "bg-status-offline/15 text-status-offline" },
  rbs_up: { label: "RBS voltou", cls: "bg-status-online/15 text-status-online" },
  flapping: { label: "Flapping", cls: "bg-status-warning/15 text-status-warning" },
};

export default function Eventos() {
  const [tipo, setTipo] = useState("all");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => { setSearch(filter.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [filter]);

  const q = useQuery({
    queryKey: ["eventos-page", tipo, search, page],
    placeholderData: keepPreviousData,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("eventos_page", {
        _tipo: tipo === "all" ? null : tipo, _search: search || null, _limit: PAGE_SIZE, _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data ?? [];
    },
  });
  const rows = q.data ?? [];
  const total = Number(rows[0]?.total_count ?? 0);
  const pi = pageInfo(total, page);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Histórico de eventos</h1>
        <p className="text-sm text-muted-foreground">Conexões, quedas individuais, quedas em massa e mudanças de estado</p>
      </div>
      <Card className="bg-gradient-card p-4 shadow-card">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <Select value={tipo} onValueChange={(v) => { setTipo(v); setPage(0); }}>
            <SelectTrigger className="md:w-60"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os tipos</SelectItem>
              <SelectItem value="disconnect">Quedas individuais</SelectItem>
              <SelectItem value="mass">Quedas em massa</SelectItem>
              <SelectItem value="connect">Conexões</SelectItem>
              <SelectItem value="device_down">Equipamento caiu</SelectItem>
              <SelectItem value="device_up">Equipamento voltou</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative md:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Buscar login ou descrição…" value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-9" />
          </div>
        </div>
      </Card>
      <Card className="bg-gradient-card shadow-card">
        {q.isError ? <QueryError onRetry={() => q.refetch()} what="o histórico" /> : (
        <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tipo</TableHead>
              <TableHead>Usuário / Equipamento</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead className="text-right">Quando</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => {
              const isMass = e.tipo === "device_down" && (e.metadata as { scope?: string } | null)?.scope === "mass";
              const t = tipoLabels[isMass ? "mass" : e.tipo] ?? { label: e.tipo, cls: "bg-muted text-muted-foreground" };
              return (
                <TableRow key={e.id}>
                  <TableCell><span className={`rounded px-2 py-0.5 text-xs font-medium ${t.cls}`}>{t.label}</span></TableCell>
                  <TableCell className="font-mono text-xs">
                    {e.username
                      ? <Link to={clientPath(e.concentrador_id, e.username)} className="text-primary hover:underline">{e.username}</Link>
                      : e.concentrador_nome ?? e.rbs_id?.slice(0, 8) ?? "—"}
                    {e.username && e.concentrador_nome && <span className="ml-1 text-muted-foreground">({e.concentrador_nome})</span>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.descricao ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground" title={new Date(e.created_at).toLocaleString("pt-BR")}>{timeAgo(e.created_at)}</TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{q.isLoading ? "Carregando…" : "Sem eventos para este filtro."}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <Pager total={total} {...pi} onPage={setPage} unit="eventos" />
        </>)}
      </Card>
    </div>
  );
}
