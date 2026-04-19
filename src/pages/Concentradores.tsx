import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusBadge } from "@/components/StatusBadge";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { formatUptime, timeAgo } from "@/lib/format";

const KEY = ["concentradores"] as const;

export default function Concentradores() {
  useRealtimeInvalidate("concentradores", KEY);
  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await supabase.from("concentradores").select("*").order("nome")).data ?? [],
  });

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Concentradores MikroTik</h1>
        <p className="text-sm text-muted-foreground">Equipamentos monitorados pelo agente coletor</p>
      </div>
      <Card className="bg-gradient-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Modelo</TableHead>
              <TableHead className="text-right">CPU</TableHead>
              <TableHead className="text-right">Memória</TableHead>
              <TableHead className="text-right">Usuários</TableHead>
              <TableHead className="text-right">Uptime</TableHead>
              <TableHead>Última coleta</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((c) => (
              <TableRow key={c.id} className="cursor-pointer hover:bg-muted/40">
                <TableCell className="font-medium">
                  <Link to={`/concentradores/${c.id}`} className="hover:underline">{c.nome}</Link>
                </TableCell>
                <TableCell className="font-mono text-xs">{c.host}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{c.modelo ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{c.cpu_load ?? "—"}%</TableCell>
                <TableCell className="text-right font-mono">{c.memory_used_pct ?? "—"}%</TableCell>
                <TableCell className="text-right font-mono">{c.usuarios_online}</TableCell>
                <TableCell className="text-right font-mono text-xs">{formatUptime(c.uptime_seconds)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{timeAgo(c.ultima_coleta)}</TableCell>
                <TableCell><StatusBadge status={c.status} /></TableCell>
              </TableRow>
            ))}
            {(data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  Nenhum concentrador cadastrado.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
