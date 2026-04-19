import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { timeAgo } from "@/lib/format";

const KEY = ["rbs"] as const;

export default function RBS() {
  useRealtimeInvalidate("rbs", KEY);
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await supabase.from("rbs").select("*").order("nome")).data ?? [],
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">RBS / Torres</h1>
        <p className="text-sm text-muted-foreground">Rádio-bases monitoradas com ping/SNMP</p>
      </div>
      <Card className="bg-gradient-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Endereço</TableHead>
              <TableHead className="text-right">Ping</TableHead>
              <TableHead className="text-right">Perda</TableHead>
              <TableHead className="text-right">Banda</TableHead>
              <TableHead>Última coleta</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((r) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-muted/40">
                <TableCell className="font-medium">
                  <Link to={`/rbs/${r.id}`} className="hover:underline">{r.nome}</Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{r.host ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.endereco ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{r.ping_ms != null ? `${r.ping_ms}ms` : "—"}</TableCell>
                <TableCell className="text-right font-mono">{r.perda_pct ?? 0}%</TableCell>
                <TableCell className="text-right font-mono">{r.uso_banda_mbps ?? 0} Mbps</TableCell>
                <TableCell className="text-xs text-muted-foreground">{timeAgo(r.ultima_coleta)}</TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
              </TableRow>
            ))}
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                  Nenhuma RBS cadastrada.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
