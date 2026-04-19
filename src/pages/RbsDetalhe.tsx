import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/hooks/useAuth";
import { timeAgo } from "@/lib/format";
import RemoteAccessTab from "@/components/RemoteAccessTab";

export default function RbsDetalhe() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["rbs", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from("rbs").select("*").eq("id", id!).single();
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;
  if (!data) return <p className="text-sm text-muted-foreground">RBS não encontrada.</p>;

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link to="/rbs"><ArrowLeft className="mr-2 h-4 w-4" />Voltar</Link>
        </Button>
      </div>
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{data.nome}</h1>
          <StatusBadge status={data.status} />
        </div>
        <p className="font-mono text-sm text-muted-foreground">{data.host ?? "sem host"}</p>
      </div>

      <Tabs defaultValue="visao">
        <TabsList>
          <TabsTrigger value="visao">Visão geral</TabsTrigger>
          <TabsTrigger value="acesso" disabled={!isAdmin}>
            Acesso Remoto {!isAdmin && "(admin)"}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="visao" className="mt-4">
          <Card className="bg-gradient-card p-6 shadow-card">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm md:grid-cols-3">
              <Field label="Endereço" value={data.endereco ?? "—"} />
              <Field label="Ping" value={data.ping_ms != null ? `${data.ping_ms}ms` : "—"} />
              <Field label="Perda" value={`${data.perda_pct ?? 0}%`} />
              <Field label="Banda" value={`${data.uso_banda_mbps ?? 0} Mbps`} />
              <Field label="Última coleta" value={timeAgo(data.ultima_coleta)} />
            </dl>
            {data.observacoes && (
              <div className="mt-4 rounded border border-border bg-muted/30 p-3 text-sm">{data.observacoes}</div>
            )}
          </Card>
        </TabsContent>

        <TabsContent value="acesso" className="mt-4">
          {isAdmin ? (
            <RemoteAccessTab kind="rbs" deviceId={data.id} defaultHost={data.host} />
          ) : (
            <p className="text-sm text-muted-foreground">Apenas administradores podem gerenciar acesso remoto.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono">{value}</dd>
    </div>
  );
}
