import { Navigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { FullScreenMsg } from "@/components/ProtectedRoute";

export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, access, hasRole } = useAuth();
  if (access === "loading") return <FullScreenMsg text="Carregando…" />;
  if (!user) return <Navigate to="/auth" replace />;
  if (!hasRole("admin")) return <Navigate to="/" replace />;
  return <>{children}</>;
}
