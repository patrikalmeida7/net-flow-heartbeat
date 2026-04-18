import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="font-mono text-sm text-muted-foreground">Carregando…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}
