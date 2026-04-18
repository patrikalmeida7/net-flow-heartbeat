import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading, hasRole } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="font-mono text-sm text-muted-foreground">Carregando…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;
  if (!hasRole("admin")) return <Navigate to="/" replace />;
  return <>{children}</>;
}
