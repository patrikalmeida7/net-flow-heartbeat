import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { normalizeEmail, safeNextPath } from "@/lib/access";

const emailSchema = z.string().trim().email("E-mail inválido").max(255);
const pwSchema = z
  .string()
  .min(10, "Mínimo 10 caracteres")
  .max(72)
  .regex(/[A-Za-z]/, "Inclua letras")
  .regex(/\d/, "Inclua números");

const NEXT_KEY = "noc_auth_next";

export default function AuthPage() {
  const { user, access } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    const n = params.get("next");
    if (n) sessionStorage.setItem(NEXT_KEY, safeNextPath(n));
    // OAuth cancel/error comes back in query or hash
    const h = new URLSearchParams(window.location.hash.slice(1));
    const err = params.get("error_description") || params.get("error") || h.get("error_description") || h.get("error");
    if (err) toast.error(/access_denied|cancel/i.test(err) ? "Login com Google cancelado" : `Falha no login: ${err}`);
  }, [params]);

  useEffect(() => {
    if (user && access !== "loading") {
      const next = safeNextPath(sessionStorage.getItem(NEXT_KEY));
      sessionStorage.removeItem(NEXT_KEY);
      navigate(next, { replace: true });
    }
  }, [user, access, navigate]);

  const google = async () => {
    setLoading(true);
    const res = await lovable.auth.signInWithOAuth("google", { redirect_uri: `${window.location.origin}/auth` });
    if (res.error) {
      setLoading(false);
      toast.error("Não foi possível entrar com Google", { description: String(res.error.message ?? res.error) });
    }
    if (!res.redirected) setLoading(false);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = emailSchema.safeParse(email);
    if (!em.success || !password) return toast.error("Informe e-mail e senha");
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email: normalizeEmail(email), password });
    setLoading(false);
    if (error) toast.error(error.message === "Invalid login credentials" ? "Credenciais inválidas" : error.message);
  };

  const handleActivate = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = emailSchema.safeParse(email);
    if (!em.success) return toast.error(em.error.errors[0].message);
    const pw = pwSchema.safeParse(password);
    if (!pw.success) return toast.error(pw.error.errors[0].message);
    setLoading(true);
    // Creates only an unconfirmed identity; access is granted solely by an admin authorization on the server.
    const { error } = await supabase.auth.signUp({
      email: normalizeEmail(email),
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth` },
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Se este e-mail foi autorizado, confirme pelo link enviado e depois entre.");
  };

  const handleForgot = async () => {
    const em = emailSchema.safeParse(email);
    if (!em.success) return toast.error("Digite seu e-mail acima primeiro");
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(normalizeEmail(email), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Se houver conta com este e-mail, enviamos o link para definir a senha.");
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-primary glow-primary">
            <Activity className="h-7 w-7 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">NOC ISP</h1>
            <p className="text-sm text-muted-foreground">Acesso restrito a contas autorizadas</p>
          </div>
        </div>

        <Card className="space-y-4 bg-gradient-card p-6 shadow-card">
          <Button type="button" variant="outline" className="w-full" onClick={google} disabled={loading}>
            Entrar com Google
          </Button>
          <div className="text-center text-xs text-muted-foreground">ou com e-mail</div>
          <Tabs defaultValue="signin" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">Entrar</TabsTrigger>
              <TabsTrigger value="activate">Primeiro acesso</TabsTrigger>
            </TabsList>

            <TabsContent value="signin">
              <form onSubmit={handleSignIn} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="email-in">E-mail</Label>
                  <Input id="email-in" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pw-in">Senha</Label>
                  <Input id="pw-in" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Entrando…" : "Entrar"}
                </Button>
                <button type="button" onClick={handleForgot} className="w-full text-center text-xs text-primary hover:underline">
                  Esqueci minha senha
                </button>
              </form>
            </TabsContent>

            <TabsContent value="activate">
              <form onSubmit={handleActivate} className="space-y-4 pt-4">
                <p className="text-xs text-muted-foreground">
                  Só funciona para e-mails liberados pelo administrador. Use o mesmo e-mail autorizado.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="email-up">E-mail autorizado</Label>
                  <Input id="email-up" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pw-up">Nova senha (10+ caracteres, letras e números)</Label>
                  <Input id="pw-up" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "Enviando…" : "Ativar acesso"}
                </Button>
              </form>
            </TabsContent>
          </Tabs>
        </Card>
      </div>
    </div>
  );
}
