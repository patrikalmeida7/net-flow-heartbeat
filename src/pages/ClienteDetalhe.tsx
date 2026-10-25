import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { formatUptime, timeAgo } from "@/lib/format";

export default function ClienteDetalhe() {
  const { username = "" } = useParams();
  const user = decodeURIComponent(username);
  const key = ["cliente", user] as const;
  useRealtimeInvalidate("pppoe_sessions", key);
  useRealtimeInvalidate("eventos", key);

  const { data } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString();
      const [s, e] = await Promise.all([
        supabase.from("pppoe_sessions").select("*").eq("username", user).order("ultima_atualizacao", { ascending: false }).limit(1),
        supabase.from("eventos").select("id, tipo, descricao, created_at").eq("username", user).gte("created_at", since).order("created_at", { ascending: false }).limit(300),
      ]);
      return { session: s.data?.[0] ?? null, eventos: e.data ?? [] };
    },
  });

  const stats = useMemo(() => {
    const ev = data?.eventos ?? [];
    const isDrop = (t: string) => /desc|off|queda|down/i.test(t);
    const day = Date.now() - 86400_000;
    const drops = ev.filter((x) => isDrop(String(x.tipo)));
    return { d24: drops.filter((x) => new Date(x.created_at).getTime() > day).length, d7: drops.length };
  }, [data]);

  const s = data?.session;
  const instavel = stats.d24 >= 3;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Link to="/pppoe" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{user}</h1>
          <p className="text-sm text-muted-foreground">Monitoramento individual do cliente</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Info label="Status" value={s ? (s.online ? "Online" : "Offline") : "—"} tone={s?.online ? "online" : "offline"} />
        <Info label="Uptime" value={s?.online ? formatUptime(s.uptime_seconds) : "—"} />
        <Info label="Quedas 24h" value={String(stats.d24)} tone={instavel ? "offline" : undefined} />
        <Info label="Quedas 7 dias" value={String(stats.d7)} />
      </div>

      <Card className="bg-gradient-card p-4 shadow-card">
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field k="IP" v={s?.ip_address} />
          <Field k="MAC (Caller-ID)" v={s?.caller_id} />
          <Field k="Interface / Serviço" v={s?.interface} />
          <Field k="Conectado" v={s?.conectado_em ? new Date(s.conectado_em).toLocaleString("pt-BR") : null} />
          <Field k="Última queda" v={s?.desconectado_em ? new Date(s.desconectado_em).toLocaleString("pt-BR") : null} />
          <Field k="Atualizado" v={timeAgo(s?.ultima_atualizacao ?? null)} />
        </div>
        {instavel && <p className="mt-3 text-sm font-medium text-status-offline">Cliente instável: 3 ou mais quedas nas últimas 24h.</p>}
      </Card>

      <Card className="bg-gradient-card shadow-card">
        <div className="border-b p-4 font-medium">Linha do tempo (7 dias)</div>
        <Table>
          <TableHeader>
            <TableRow><TableHead>Quando</TableHead><TableHead>Evento</TableHead><TableHead>Detalhe</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {(data?.eventos ?? []).map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-xs">{new Date(e.created_at).toLocaleString("pt-BR")}</TableCell>
                <TableCell className="text-xs font-medium">{String(e.tipo)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{e.descricao ?? "—"}</TableCell>
              </TableRow>
            ))}
            {!data?.eventos.length && (
              <TableRow><TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">Nenhum evento nos últimos 7 dias.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
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
