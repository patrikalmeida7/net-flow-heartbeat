import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBytes, formatUptime, timeAgo } from "@/lib/format";
import { clientPath, pageInfo, PAGE_SIZE } from "@/lib/clientLink";
import { SESSION_STALE_MS } from "@/lib/collectionHealth";
import { Pager, QueryError } from "@/components/Pager";

export default function ClienteDetalhe() {
  const { username = "", concentradorId } = useParams();
  const user = decodeURIComponent(username);

  // Link antigo (só login): lista os concentradores onde o login existe
  const matches = useQuery({
    queryKey: ["cliente-matches", user],
    enabled: !concentradorId,
    queryFn: async () => {
      const { data, error } = await supabase.from("pppoe_sessions").select("concentrador_id, concentradores(nome)").eq("username", user).limit(1000);
      if (error) throw error;
      const m = new Map<string, string>();
      for (const r of data ?? []) if (r.concentrador_id) m.set(r.concentrador_id, (r.concentradores as { nome: string } | null)?.nome ?? r.concentrador_id);
      return [...m.entries()];
    },
  });

  const [page, setPage] = useState(0);
  const base = useQuery({
    queryKey: ["cliente", concentradorId, user],
    enabled: !!concentradorId,
    refetchInterval: 15000,
    queryFn: async () => {
      const [s, st, c] = await Promise.all([
        supabase.from("pppoe_sessions").select("*").eq("concentrador_id", concentradorId!).eq("username", user).order("ultima_atualizacao", { ascending: false }).limit(1),
        supabase.rpc("client_drop_stats", { _concentrador: concentradorId!, _username: user }),
        supabase.from("concentradores").select("nome").eq("id", concentradorId!).maybeSingle(),
      ]);
      if (s.error) throw s.error;
      if (st.error) throw st.error;
      return {
        session: s.data?.[0] ?? null,
        stats: st.data as { individual_24h: number; individual_7d: number; mass_7d: number; sessions: number },
        conc: c.data?.nome ?? null,
      };
    },
  });
  const ev = useQuery({
    queryKey: ["cliente-ev", concentradorId, user, page],
    enabled: !!concentradorId,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const { data, error } = await supabase.rpc("eventos_page", {
        _concentrador: concentradorId!, _username: user, _since: since, _limit: PAGE_SIZE, _offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

  if (!concentradorId) {
    return (
      <div className="space-y-6 animate-fade-in">
        <Header user={user} sub="Escolha o concentrador deste login" />
        <Card className="p-4">
          {matches.isError ? <QueryError onRetry={() => matches.refetch()} what="o cliente" /> :
            matches.isLoading ? <p className="text-sm text-muted-foreground">Carregando…</p> :
            !matches.data?.length ? <p className="text-sm text-muted-foreground">Login não encontrado.</p> : (
              <ul className="space-y-2 text-sm">
                {matches.data.map(([id, nome]) => (
                  <li key={id}><Link className="text-primary hover:underline" to={clientPath(id, user)}>{user} em {nome}</Link></li>
                ))}
              </ul>
            )}
        </Card>
      </div>
    );
  }

  const s = base.data?.session;
  const st = base.data?.stats;
  const stale = !!s?.online && Date.now() - new Date(s.ultima_atualizacao).getTime() > SESSION_STALE_MS;
  const instavel = (st?.individual_24h ?? 0) >= 3;
  const rows = ev.data ?? [];
  const total = Number(rows[0]?.total_count ?? 0);
  const pi = pageInfo(total, page);

  return (
    <div className="space-y-6 animate-fade-in">
      <Header user={user} sub={`Monitoramento individual · ${base.data?.conc ?? "concentrador"}`} />
      {base.isError ? <Card><QueryError onRetry={() => base.refetch()} what="o cliente" /></Card> : (
      <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Status" value={!base.data ? "…" : !s ? "Sem dados" : stale ? "Último estado: online" : s.online ? "Online" : "Offline"}
          tone={stale ? undefined : s?.online ? "online" : "offline"} />
        <Info label="Uptime" value={s?.online && !stale ? formatUptime(s.uptime_seconds) : "—"} />
        <Info label="Quedas individuais 24h" value={st ? String(st.individual_24h) : "…"} tone={instavel ? "offline" : undefined} />
        <Info label="Quedas 7 dias" value={st ? `${st.individual_7d} individuais · ${st.mass_7d} em massa` : "…"} />
      </div>

      <Card className="bg-gradient-card p-4 shadow-card">
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field k="IP" v={s?.ip_address} />
          <Field k="MAC (Caller-ID)" v={s?.caller_id} />
          <Field k="Interface / Serviço" v={s?.interface} />
          <Field k="Conectado" v={s?.conectado_em ? new Date(s.conectado_em).toLocaleString("pt-BR") : null} />
          <Field k="Última queda" v={s?.desconectado_em ? new Date(s.desconectado_em).toLocaleString("pt-BR") : null} />
          <Field k="Atualizado" v={s ? timeAgo(s.ultima_atualizacao) : null} />
          <Field k="Download (sessão)" v={s?.bytes_in ? formatBytes(s.bytes_in) : "Sem dados"} />
          <Field k="Upload (sessão)" v={s?.bytes_out ? formatBytes(s.bytes_out) : "Sem dados"} />
          <Field k="Registros de sessão" v={st ? String(st.sessions) : null} />
        </div>
        {stale && <p className="mt-3 text-sm text-status-warning">Sem atualização do coletor há mais de 5 minutos — status exibido é o último conhecido.</p>}
        {instavel && <p className="mt-3 text-sm font-medium text-status-offline">Cliente instável: 3 ou mais quedas individuais nas últimas 24h (quedas em massa não contam).</p>}
      </Card>

      <Card className="bg-gradient-card shadow-card">
        <div className="border-b p-4 font-medium">Linha do tempo (7 dias)</div>
        {ev.isError ? <QueryError onRetry={() => ev.refetch()} what="a linha do tempo" /> : (
        <>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Quando</TableHead><TableHead>Evento</TableHead><TableHead>Detalhe</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => {
              const mass = e.tipo === "device_down" && (e.metadata as { scope?: string } | null)?.scope === "mass";
              return (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-xs">{new Date(e.created_at).toLocaleString("pt-BR")}</TableCell>
                  <TableCell className="text-xs font-medium">{mass ? "Queda em massa" : e.tipo === "disconnect" ? "Queda individual" : e.tipo === "connect" ? "Conexão" : e.tipo}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{e.descricao ?? "—"}</TableCell>
                </TableRow>
              );
            })}
            {!rows.length && (
              <TableRow><TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">{ev.isLoading ? "Carregando…" : "Nenhum evento nos últimos 7 dias."}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <Pager total={total} {...pi} onPage={setPage} unit="eventos" />
        </>)}
      </Card>
      </>)}
    </div>
  );
}

function Header({ user, sub }: { user: string; sub: string }) {
  return (
    <div className="flex items-center gap-3">
      <Link to="/pppoe" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
      <div>
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{user}</h1>
        <p className="text-sm text-muted-foreground">{sub}</p>
      </div>
    </div>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: "online" | "offline" }) {
  const c = tone === "online" ? "text-status-online" : tone === "offline" ? "text-status-offline" : "";
  return (
    <Card className="bg-gradient-card p-4 shadow-card">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold ${c}`}>{value}</p>
    </Card>
  );
}

function Field({ k, v }: { k: string; v: string | null | undefined }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{k}</p>
      <p className="font-mono">{v || "—"}</p>
    </div>
  );
}
