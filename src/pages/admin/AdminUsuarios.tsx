import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { normalizeEmail, type AppRole } from "@/lib/access";

const ROLES: AppRole[] = ["visualizador", "tecnico", "admin"];
const NONE = "__none";

export default function AdminUsuarios() {
  const qc = useQueryClient();
  const { user: me, refreshAccess } = useAuth();
  const [form, setForm] = useState({ email: "", full_name: "", role: "visualizador" as AppRole, organization_id: NONE });

  const auths = useQuery({
    queryKey: ["access-authorizations"],
    queryFn: async () => {
      const { data, error } = await supabase.from("access_authorizations").select("*").order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
  const accounts = useQuery({
    queryKey: ["admin-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("admin_list_accounts");
      if (error) throw error;
      return data ?? [];
    },
  });
  const orgs = useQuery({
    queryKey: ["orgs-min"],
    queryFn: async () => (await supabase.from("organizations").select("id, nome").order("nome")).data ?? [],
  });

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["access-authorizations"] });
    qc.invalidateQueries({ queryKey: ["admin-accounts"] });
    refreshAccess();
  };
  const fail = (m: string, e: { message: string }) => toast.error(m, { description: e.message });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = normalizeEmail(form.email);
    if (!/^\S+@\S+\.\S+$/.test(email)) return toast.error("E-mail inválido");
    const { error } = await supabase.from("access_authorizations").insert({
      email,
      full_name: form.full_name.trim() || null,
      role: form.role,
      organization_id: form.organization_id === NONE ? null : form.organization_id,
      status: "active",
    });
    if (error) return fail(error.code === "23505" ? "E-mail já autorizado" : "Erro ao autorizar", error);
    toast.success("Acesso autorizado");
    setForm({ email: "", full_name: "", role: "visualizador", organization_id: NONE });
    reload();
  };

  const update = async (id: string, patch: { role?: AppRole; status?: string }) => {
    const { error } = await supabase.from("access_authorizations").update(patch).eq("id", id);
    if (error) return fail("Não foi possível alterar", error);
    toast.success("Acesso atualizado");
    reload();
  };
  const remove = async (id: string) => {
    const { error } = await supabase.from("access_authorizations").delete().eq("id", id);
    if (error) return fail("Não foi possível remover", error);
    toast.success("Autorização removida");
    reload();
  };
  const sendReset = async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
    if (error) return fail("Falha ao enviar", error);
    toast.success("Link de definição de senha enviado (se a conta existir)");
  };

  const authorized = new Set((auths.data ?? []).map((a) => a.email));
  const accountByEmail = new Map((accounts.data ?? []).map((a) => [a.email, a]));
  const pending = (accounts.data ?? []).filter((a) => a.email && !authorized.has(a.email));

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Só entra quem estiver autorizado aqui, pelo e-mail exato (Google verificado ou e-mail/senha). Bloquear corta o acesso na hora, inclusive de quem já está logado.
      </p>

      <form onSubmit={add} className="grid gap-3 rounded-md border border-border p-4 md:grid-cols-5">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="au-email">E-mail</Label>
          <Input id="au-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="au-name">Nome</Label>
          <Input id="au-name" value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label>Papel</Label>
          <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as AppRole })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Empresa</Label>
          <Select value={form.organization_id} onValueChange={(v) => setForm({ ...form, organization_id: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {(orgs.data ?? []).map((o) => <SelectItem key={o.id} value={o.id}>{o.nome}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-5">
          <Button type="submit" size="sm" className="gap-2"><Plus className="h-4 w-4" /> Autorizar acesso</Button>
        </div>
      </form>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Autorizado</TableHead>
              <TableHead>Papel</TableHead>
              <TableHead>Situação</TableHead>
              <TableHead>Conta</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {auths.isLoading && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>}
            {auths.error && <TableRow><TableCell colSpan={5} className="text-center text-destructive">{(auths.error as Error).message}</TableCell></TableRow>}
            {auths.data?.map((a) => {
              const acc = accountByEmail.get(a.email);
              const isMe = acc?.user_id === me?.id;
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="font-medium">{a.full_name ?? "—"} {isMe && <span className="text-[10px] uppercase text-primary">você</span>}</div>
                    <div className="font-mono text-xs text-muted-foreground">{a.email}</div>
                  </TableCell>
                  <TableCell>
                    <Select value={a.role} onValueChange={(v) => update(a.id, { role: v as AppRole })}>
                      <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                      <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Badge variant={a.status === "active" ? "default" : "destructive"}>{a.status === "active" ? "Ativo" : "Bloqueado"}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {acc ? `${acc.providers?.join(", ")}${acc.email_confirmed ? "" : " (não confirmado)"}` : "ainda não entrou"}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button size="sm" variant="ghost" onClick={() => update(a.id, { status: a.status === "active" ? "blocked" : "active" })}>
                      {a.status === "active" ? "Bloquear" : "Reativar"}
                    </Button>
                    {acc && <Button size="sm" variant="ghost" onClick={() => sendReset(a.email)}>Enviar link de senha</Button>}
                    <Button size="sm" variant="ghost" onClick={() => remove(a.id)} aria-label="Remover autorização">
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {pending.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Contas sem autorização (sem acesso a nada)</h3>
          <div className="rounded-md border border-border">
            <Table>
              <TableBody>
                {pending.map((p) => (
                  <TableRow key={p.user_id}>
                    <TableCell className="font-mono text-xs">{p.email}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.providers?.join(", ")}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => setForm({ ...form, email: p.email })}>Preencher para autorizar</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
