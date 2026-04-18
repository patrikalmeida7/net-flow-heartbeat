import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";
import { timeAgo } from "@/lib/format";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const KEY = ["alertas"] as const;

export default function Alertas() {
  useRealtimeInvalidate("alertas", KEY);
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const canAct = hasRole("admin") || hasRole("tecnico");

  const { data } = useQuery({
    queryKey: KEY,
    queryFn: async () => (await supabase.from("alertas").select("*").order("created_at", { ascending: false })).data ?? [],
  });

  const acknowledge = async (id: string) => {
    const { error } = await supabase
      .from("alertas")
      .update({ status: "acknowledged", reconhecido_em: new Date().toISOString() })
      .eq("id", id);
    if (error) toast.error(error.message);
    else {
      toast.success("Alerta reconhecido");
      qc.invalidateQueries({ queryKey: KEY });
    }
  };

  const resolve = async (id: string) => {
    const { error } = await supabase
      .from("alertas")
      .update({ status: "resolved", resolvido_em: new Date().toISOString() })
      .eq("id", id);
    if (error) toast.error(error.message);
    else {
      toast.success("Alerta resolvido");
      qc.invalidateQueries({ queryKey: KEY });
    }
  };

  const ativos = (data ?? []).filter((a) => a.status === "active");
  const reconhecidos = (data ?? []).filter((a) => a.status === "acknowledged");
  const resolvidos = (data ?? []).filter((a) => a.status === "resolved");

  const renderList = (list: typeof ativos, allowActions: boolean) => (
    <div className="space-y-2">
      {list.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Nenhum alerta.</p>}
      {list.map((a) => (
        <div
          key={a.id}
          className={cn(
            "rounded-lg border p-4",
            a.severidade === "critical"
              ? "border-severity-critical/40 bg-severity-critical/10"
              : a.severidade === "warning"
                ? "border-severity-warning/40 bg-severity-warning/10"
                : "border-severity-info/40 bg-severity-info/10",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    a.severidade === "critical"
                      ? "bg-severity-critical/30 text-severity-critical"
                      : a.severidade === "warning"
                        ? "bg-severity-warning/30 text-severity-warning"
                        : "bg-severity-info/30 text-severity-info",
                  )}
                >
                  {a.severidade}
                </span>
                <span className="font-semibold">{a.titulo}</span>
              </div>
              {a.descricao && <p className="mt-1 text-sm text-muted-foreground">{a.descricao}</p>}
              <p className="mt-1 text-xs text-muted-foreground">Criado {timeAgo(a.created_at)}</p>
            </div>
            {allowActions && canAct && (
              <div className="flex gap-2">
                {a.status === "active" && (
                  <Button size="sm" variant="secondary" onClick={() => acknowledge(a.id)}>
                    <Check className="mr-1 h-3.5 w-3.5" /> Reconhecer
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => resolve(a.id)}>
                  <X className="mr-1 h-3.5 w-3.5" /> Resolver
                </Button>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Alertas</h1>
        <p className="text-sm text-muted-foreground">Incidentes detectados pelo sistema</p>
      </div>

      <Card className="bg-gradient-card p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Ativos ({ativos.length})
        </h2>
        {renderList(ativos, true)}
      </Card>

      <Card className="bg-gradient-card p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Reconhecidos ({reconhecidos.length})
        </h2>
        {renderList(reconhecidos, true)}
      </Card>

      <Card className="bg-gradient-card p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Resolvidos ({resolvidos.length})
        </h2>
        {renderList(resolvidos.slice(0, 20), false)}
      </Card>
    </div>
  );
}
