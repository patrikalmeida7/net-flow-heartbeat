import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    if (h.get("error") || h.get("error_description")) setInvalid(true);
    const { data: sub } = supabase.auth.onAuthStateChange((e) => {
      if (e === "PASSWORD_RECOVERY") setReady(true);
    });
    if (h.get("type") === "recovery") setReady(true);
    const t = setTimeout(() => setInvalid((v) => v || !h.get("type")), 4000);
    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(t);
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return toast.error("Mínimo 10 caracteres, com letras e números");
    if (pw !== pw2) return toast.error("As senhas não conferem");
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Senha definida");
    navigate("/", { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md space-y-4 bg-gradient-card p-6 shadow-card">
        <h1 className="text-lg font-semibold">Definir nova senha</h1>
        {!ready && invalid ? (
          <div className="space-y-3 text-sm text-muted-foreground">
            <p>Link inválido ou expirado. Peça um novo em "Esqueci minha senha".</p>
            <Button variant="outline" onClick={() => navigate("/auth")}>Voltar ao login</Button>
          </div>
        ) : !ready ? (
          <p className="text-sm text-muted-foreground">Validando link…</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="np">Nova senha</Label>
              <Input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="np2">Repita a senha</Label>
              <Input id="np2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>{loading ? "Salvando…" : "Salvar senha"}</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
