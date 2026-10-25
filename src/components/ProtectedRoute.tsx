import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function FullScreenMsg({ text }: { text: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="font-mono text-sm text-muted-foreground">{text}</div>
    </div>
  );
}

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, access, signOut, refreshAccess } = useAuth();
  const loc = useLocation();

  if (access === "loading") return <FullScreenMsg text="Carregando…" />;
  if (access === "signed_out" || !user)
    return <Navigate to={`/auth?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (access !== "active") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="max-w-md space-y-4 bg-gradient-card p-6 text-center shadow-card">
          <h1 className="text-lg font-semibold">
            {access === "error" ? "Não foi possível verificar seu acesso" : "Acesso não autorizado"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {access === "error"
              ? "Tente novamente em instantes."
              : <>A conta <span className="font-mono">{user.email}</span> não tem autorização ativa. Peça ao administrador para liberar este e-mail.</>}
          </p>
          <div className="flex justify-center gap-2">
            <Button variant="outline" onClick={refreshAccess}>Verificar de novo</Button>
            <Button onClick={signOut}>Sair</Button>
          </div>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
