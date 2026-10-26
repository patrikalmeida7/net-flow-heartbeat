import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type Row = { concentrador_nome?: string | null; username: string; count?: number; bytes_in?: number | null; bytes_out?: number | null };
const fmtB = (b?: number | null) => (b == null ? "Sem dados" : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const PAGE = 15;

export function DailyReportsHistory() {
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["daily_reports", page],
    queryFn: async () => {
      const { data, error, count } = await supabase.from("daily_reports").select("*", { count: "exact" })
        .order("report_date", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });
  if (q.isLoading) return <p className="py-4 text-center text-sm text-muted-foreground">Carregando…</p>;
  if (q.error) return <div className="py-4 text-center text-sm text-severity-critical">Erro ao carregar. <Button size="sm" variant="outline" onClick={() => q.refetch()}>Tentar de novo</Button></div>;
  const { rows, total } = q.data!;
  return (
    <Card className="bg-gradient-card p-5 shadow-card space-y-2">
      <p className="text-xs text-muted-foreground">Cada manhã o relatório do dia anterior fica guardado aqui. Consumo é aproximado (fotografias API).</p>
      {rows.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nenhum relatório guardado ainda.</p>}
      {rows.map((r) => {
        const s = (r.summary ?? {}) as Record<string, number>;
        const [y, m, d] = r.report_date.split("-");
        return (
          <div key={r.id} className="rounded-md border border-border p-3 text-sm">
            <button className="flex w-full items-center justify-between" onClick={() => setOpen(open === r.id ? null : r.id)}>
              <span className="font-medium">{d}/{m}/{y}</span>
              <span className="flex gap-2 text-xs text-muted-foreground">
                {s.individual_drops ?? "?"} quedas · {s.mass_incidents ?? "?"} em massa
                <Badge variant={r.status === "sent" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>
                  {r.status === "sent" ? "Enviado" : r.status === "failed" ? "Falha no envio" : "Gerado"}
                </Badge>
              </span>
            </button>
            {open === r.id && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div><p className="mb-1 font-medium">Mais quedas</p>
                  {((r.top_drops as Row[]) ?? []).map((x, i) => <p key={i}>{i + 1}. {x.username} <span className="text-muted-foreground">({x.concentrador_nome ?? "?"})</span> — {x.count}</p>)}
                  {!(r.top_drops as Row[])?.length && <p className="text-muted-foreground">Nenhuma queda.</p>}
                </div>
                <div><p className="mb-1 font-medium">Maior consumo</p>
                  {((r.top_consumers as Row[]) ?? []).map((x, i) => <p key={i}>{i + 1}. {x.username} <span className="text-muted-foreground">({x.concentrador_nome ?? "?"})</span> — ↓{fmtB(x.bytes_out)} ↑{fmtB(x.bytes_in)}</p>)}
                  {!(r.top_consumers as Row[])?.length && <p className="text-muted-foreground">Sem dados.</p>}
                </div>
                {r.message_text && <pre className="md:col-span-2 whitespace-pre-wrap rounded bg-muted p-2 font-sans text-xs">{r.message_text}</pre>}
              </div>
            )}
          </div>
        );
      })}
      {total > PAGE && (
        <div className="flex justify-end gap-2 pt-2">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button>
          <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Próxima</Button>
        </div>
      )}
    </Card>
  );
}
