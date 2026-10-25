import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { devicesHealth, healthLabel, type HealthState } from "@/lib/collectionHealth";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function useCollectionHealth() {
  const q = useQuery({
    queryKey: ["collection-health"],
    refetchInterval: 15000,
    queryFn: async () => {
      const [c, a] = await Promise.all([
        supabase.from("concentradores").select("id, nome, status, ultima_coleta, last_collect_error, offline_since"),
        supabase.from("agents").select("last_seen_at").eq("enabled", true),
      ]);
      if (c.error) throw c.error;
      const agentSeen = (a.data ?? []).map((x) => x.last_seen_at).filter(Boolean).sort().pop() ?? null;
      return { devices: c.data ?? [], agentSeen };
    },
  });
  const h = devicesHealth(q.data?.devices ?? []);
  const last = (q.data?.devices ?? []).map((d) => d.ultima_coleta).filter(Boolean).sort()[0] ?? null; // a mais antiga
  return { ...q, state: (q.data ? h.worst : "no_data") as HealthState, devices: h.list, problems: h.problems, last, agentSeen: q.data?.agentSeen ?? null };
}

export function healthDot(state: HealthState) {
  return state === "ok" ? "bg-status-online" : state === "delayed" ? "bg-status-warning" : state === "no_data" ? "bg-muted-foreground" : "bg-status-offline";
}

export function CollectionHealthBadge() {
  const { state, last, agentSeen, problems, isError, isLoading } = useCollectionHealth();
  const label = isLoading ? "Verificando coleta…" : isError ? "Erro ao verificar coleta" : healthLabel[state];
  const title = [
    agentSeen ? `Coletor (heartbeat): ${timeAgo(agentSeen)}` : "Coletor sem heartbeat",
    ...problems.map((p) => `${p.nome}: ${healthLabel[p.state]}${p.ultima_coleta ? ` — dado válido ${timeAgo(p.ultima_coleta)}` : ""}`),
  ].join("\n");
  return (
    <div className="flex items-center gap-3" title={title}>
      <span className={cn("h-2 w-2 rounded-full", isError ? "bg-status-offline" : healthDot(state), state === "ok" && "animate-pulse")} />
      <span className="text-sm font-medium">{label}</span>
      {last && <span className="hidden text-xs text-muted-foreground sm:inline">dado válido mais antigo {timeAgo(last)}</span>}
      {problems.length > 0 && <span className="hidden text-xs text-status-warning md:inline">{problems.length} equipamento(s) com problema</span>}
    </div>
  );
}
