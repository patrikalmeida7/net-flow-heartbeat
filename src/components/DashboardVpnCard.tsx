import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Network, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

const KEY = ["dashboard-vpn"] as const;

export function DashboardVpnCard() {
  useRealtimeInvalidate("vpn_status", KEY);
  useRealtimeInvalidate("vpn_connections", KEY);

  const { data } = useQuery({
    queryKey: KEY,
    refetchInterval: 15_000,
    queryFn: async () => {
      const { data: conns, error } = await supabase
        .from("vpn_connections")
        .select("id, nome, protocol, desired_state, enabled")
        .eq("enabled", true);
      if (error) throw error;
      const ids = (conns ?? []).map((c) => c.id);
      if (ids.length === 0) return { conns: [], statuses: new Map() };
      const { data: st } = await supabase.from("vpn_status").select("*").in("vpn_connection_id", ids);
      return { conns: conns ?? [], statuses: new Map((st ?? []).map((s) => [s.vpn_connection_id, s])) };
    },
  });

  const conns = data?.conns ?? [];
  const statuses = data?.statuses ?? new Map();
  const online = conns.filter((c) => statuses.get(c.id)?.online).length;
  const total = conns.length;
  const tone = total === 0 ? "muted" : online === total ? "online" : online === 0 ? "offline" : "warning";

  return (
    <Card className="bg-gradient-card p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Túneis VPN</h2>
        </div>
        <Link to="/admin" className="text-xs text-primary hover:underline">
          Gerenciar <ChevronRight className="inline h-3 w-3" />
        </Link>
      </div>

      <div className="mb-3 flex items-baseline gap-2">
        <span className={`text-3xl font-semibold ${tone === "online" ? "text-status-online" : tone === "offline" ? "text-status-offline" : tone === "warning" ? "text-status-warning" : ""}`}>
          {online}
        </span>
        <span className="text-sm text-muted-foreground">/ {total} ativos</span>
      </div>

      {total === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum túnel cadastrado. Vá em Administração → VPN.</p>
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {conns.map((c) => {
            const s = statuses.get(c.id);
            return (
              <div key={c.id} className="flex items-center justify-between rounded border border-border bg-secondary/40 px-2.5 py-1.5 text-sm">
                <div className="min-w-0">
                  <div className="truncate font-medium">{c.nome}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {c.protocol === "wireguard" ? "WG" : "OVPN"}
                    {s?.latency_ms != null && ` • ${s.latency_ms}ms`}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className={s?.online ? "border-status-online/40 text-status-online" : "border-status-offline/40 text-status-offline"}
                >
                  {s?.online ? "online" : "offline"}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
