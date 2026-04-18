import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Activity, AlertTriangle, BarChart3, Gauge, History, LogOut, Radio, Server, Settings, Users } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Dashboard NOC", icon: Gauge, end: true },
  { to: "/concentradores", label: "Concentradores", icon: Server },
  { to: "/rbs", label: "RBS / Torres", icon: Radio },
  { to: "/pppoe", label: "Usuários PPPoE", icon: Users },
  { to: "/metricas", label: "Métricas SNMP", icon: BarChart3 },
  { to: "/alertas", label: "Alertas", icon: AlertTriangle },
  { to: "/eventos", label: "Histórico", icon: History },
];

const adminNav = [
  { to: "/admin", label: "Administração", icon: Settings },
];

function LiveClock() {
  const now = new Date();
  return (
    <span className="font-mono text-sm tabular-nums text-muted-foreground">
      {now.toLocaleTimeString("pt-BR")}
    </span>
  );
}

export default function AppLayout() {
  const { user, signOut, roles, hasRole } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  const items = hasRole("admin") ? [...nav, ...adminNav] : nav;

  return (
    <div className="flex min-h-screen w-full">
      {/* Sidebar */}
      <aside className="hidden w-64 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-16 items-center gap-2 border-b border-sidebar-border px-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-primary glow-primary">
            <Activity className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight text-sidebar-foreground">NOC ISP</div>
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Network Ops</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-3">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={(item as { end?: boolean }).end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="mb-2 px-2 text-xs text-muted-foreground">
            <div className="truncate font-medium text-sidebar-foreground">{user?.email}</div>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {roles.length === 0 && <span className="text-[10px]">sem papel</span>}
              {roles.map((r) => (
                <span
                  key={r}
                  className="rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-secondary-foreground"
                >
                  {r}
                </span>
              ))}
            </div>
          </div>
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sair
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
          <div className="flex items-center gap-3">
            <span className="hidden h-2 w-2 animate-pulse rounded-full bg-status-online md:inline-block" />
            <span className="text-sm font-medium">Monitoramento ativo</span>
          </div>
          <LiveClock />
        </header>
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
