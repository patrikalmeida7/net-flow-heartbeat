import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { timeAgo } from "@/lib/format";

const KEY = ["eventos"] as const;

const tipoLabels: Record<string, { label: string; cls: string }> = {
  connect: { label: "Conexão", cls: "bg-status-online/15 text-status-online" },
  disconnect: { label: "Desconexão", cls: "bg-muted text-muted-foreground" },
  device_down: { label: "Equipamento caiu", cls: "bg-status-offline/15 text-status-offline" },
  device_up: { label: "Equipamento voltou", cls: "bg-status-online/15 text-status-online" },
  rbs_down: { label: "RBS caiu", cls: "bg-status-offline/15 text-status-offline" },
  rbs_up: { label: "RBS voltou", cls: "bg-status-online/15 text-status-online" },
  flapping: { label: "Flapping", cls: "bg-status-warning/15 text-status-warning" },
};

export default function Eventos() {
  useRealtimeInvalidate("eventos", KEY);
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () =>
      (await supabase.from("eventos").select("*").order("created_at", { ascending: false }).limit(200)).data ?? [],
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Histórico de eventos</h1>
        <p className="text-sm text-muted-foreground">Conexões, quedas e mudanças de estado</p>
      </div>
      <Card className="bg-gradient-card shadow-card">
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
            {(data ?? []).map((e) => {
              const t = tipoLabels[e.tipo] ?? { label: e.tipo, cls: "bg-muted text-muted-foreground" };
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${t.cls}`}>{t.label}</span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.username ?? e.concentrador_id?.slice(0, 8) ?? e.rbs_id?.slice(0, 8) ?? "—"}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{e.descricao ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(e.created_at)}</TableCell>
                </TableRow>
              );
            })}
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  Sem eventos registrados.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
