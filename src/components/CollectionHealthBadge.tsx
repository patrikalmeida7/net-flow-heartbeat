import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { collectionHealth, healthLabel } from "@/lib/collectionHealth";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export function useCollectionHealth() {
  const q = useQuery({
    queryKey: ["collection-health"],
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase.from("concentradores").select("status, ultima_coleta");
      if (error) throw error;
      const last = (data ?? []).map((c) => c.ultima_coleta).filter(Boolean).sort().pop() ?? null;
      return { last, anyOffline: (data ?? []).some((c) => c.status === "offline") };
    },
  });
  const state = q.data ? collectionHealth({ lastCollectAt: q.data.last, anyDeviceOffline: q.data.anyOffline }) : "no_data";
  return { ...q, state, last: q.data?.last ?? null };
}

export function CollectionHealthBadge() {
  const { state, last, isError } = useCollectionHealth();
  const dot =
    state === "ok" ? "bg-status-online animate-pulse" : state === "delayed" || state === "device_down" ? "bg-status-warning" : "bg-status-offline";
  return (
    <div className="flex items-center gap-3">
      <span className={cn("h-2 w-2 rounded-full", isError ? "bg-status-offline" : dot)} />
      <span className="text-sm font-medium">{isError ? "Erro ao verificar coleta" : healthLabel[state]}</span>
      {last && <span className="hidden text-xs text-muted-foreground sm:inline">última coleta {timeAgo(last)}</span>}
    </div>
  );
}
