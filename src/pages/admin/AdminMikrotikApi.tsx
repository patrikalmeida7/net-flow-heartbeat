import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Terminal, Copy } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { timeAgo } from "@/lib/format";
import { buildMikrotikScript } from "@/lib/mikrotikScript";

const empty = { concentrador_id: "", agent_id: "", host: "", port: "8728", use_tls: false, username: "noc-api", password: "", routeros_version: "v7" as "v6" | "v7" };

function genPassword() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 56]).join("");
}

export default function AdminMikrotikApi() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [saving, setSaving] = useState(false);
  const [script, setScript] = useState<string | null>(null);

  const { data: rows = [] } = useQuery({
    queryKey: ["mk-api"],
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase.from("mikrotik_api_credentials")
        .select("*, concentradores(nome), agents(nome)").order("created_at");
      if (error) throw error;
      return data;
    },
  });
  const { data: concs = [] } = useQuery({
    queryKey: ["concs-min"],
    queryFn: async () => (await supabase.from("concentradores").select("id, nome, host").order("nome")).data ?? [],
  });
  const { data: agents = [] } = useQuery({
    queryKey: ["agents-min"],
    queryFn: async () => (await supabase.from("agents").select("id, nome").order("nome")).data ?? [],
  });

  async function save() {
    if (!form.concentrador_id || !form.agent_id || !form.host || !form.username || form.password.length < 8) {
      toast.error("Preencha concentrador, coletor, host, usuário e senha (mín. 8).");
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.from("mikrotik_api_credentials").insert({
      concentrador_id: form.concentrador_id, agent_id: form.agent_id, host: form.host.trim(),
      port: Number(form.port) || 8728, use_tls: form.use_tls, username: form.username.trim(),
      routeros_version: form.routeros_version,
    }).select("id").single();
    if (!error && data) {
      const r = await supabase.rpc("set_mikrotik_api_password", { _id: data.id, _password: form.password });
      if (r.error) toast.error(r.error.message);
    }
    setSaving(false);
    if (error) return toast.error(error.message);
    setScript(buildMikrotikScript({ ...form, port: Number(form.port) || 8728 }));
    setOpen(false);
    toast.success("MikroTik cadastrado. O coletor começa a monitorar em até 1 minuto.");
    qc.invalidateQueries({ queryKey: ["mk-api"] });
  }

  async function toggle(id: string, enabled: boolean) {
    await supabase.from("mikrotik_api_credentials").update({ enabled }).eq("id", id);
    qc.invalidateQueries({ queryKey: ["mk-api"] });
  }
  async function remove(id: string) {
    if (!confirm("Remover monitoramento via API deste MikroTik?")) return;
    await supabase.from("mikrotik_api_credentials").delete().eq("id", id);
    qc.invalidateQueries({ queryKey: ["mk-api"] });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">MikroTiks monitorados via API RouterOS (v6 e v7). O coletor busca esta lista sozinho.</p>
        <Button onClick={() => { setForm({ ...empty, password: genPassword() }); setOpen(true); }} className="gap-2">
          <Plus className="h-4 w-4" /> Novo MikroTik
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Concentrador</TableHead><TableHead>Host</TableHead><TableHead>Versão</TableHead>
            <TableHead>Coletor</TableHead><TableHead>Última coleta</TableHead><TableHead>Ativo</TableHead><TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Nenhum MikroTik cadastrado.</TableCell></TableRow>
          )}
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.concentradores?.nome}</TableCell>
              <TableCell className="font-mono text-xs">{r.host}:{r.port}{r.use_tls ? " (TLS)" : ""}</TableCell>
              <TableCell><Badge variant="outline">{r.routeros_version}</Badge></TableCell>
              <TableCell>{r.agents?.nome ?? "—"}</TableCell>
              <TableCell>
                {r.last_error ? <Badge variant="destructive" title={r.last_error}>erro</Badge>
                  : r.last_poll_at ? <span className="text-xs">{timeAgo(r.last_poll_at)}</span>
                  : <span className="text-xs text-muted-foreground">aguardando</span>}
              </TableCell>
              <TableCell><Switch checked={r.enabled} onCheckedChange={(v) => toggle(r.id, v)} /></TableCell>
              <TableCell className="text-right">
                <Button size="icon" variant="ghost" onClick={() => remove(r.id)}><Trash2 className="h-4 w-4" /></Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Novo MikroTik (API)</DialogTitle>
            <DialogDescription>Depois de salvar você recebe o script para colar no terminal do MikroTik.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1"><Label>Concentrador</Label>
              <Select value={form.concentrador_id} onValueChange={(v) => {
                const c = concs.find((x) => x.id === v);
                setForm({ ...form, concentrador_id: v, host: form.host || c?.host || "" });
              }}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{concs.map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid gap-1"><Label>Coletor (VPS)</Label>
              <Select value={form.agent_id} onValueChange={(v) => setForm({ ...form, agent_id: v })}>
                <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                <SelectContent>{agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 grid gap-1"><Label>Host (IP na VPN)</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.8.0.10" /></div>
              <div className="grid gap-1"><Label>Porta</Label>
                <Input value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1"><Label>RouterOS</Label>
                <Select value={form.routeros_version} onValueChange={(v) => setForm({ ...form, routeros_version: v as "v6" | "v7" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="v6">v6</SelectItem><SelectItem value="v7">v7</SelectItem></SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2 pb-2">
                <Switch checked={form.use_tls} onCheckedChange={(v) => setForm({ ...form, use_tls: v, port: v ? "8729" : "8728" })} />
                <Label>API-SSL</Label>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1"><Label>Usuário API</Label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
              <div className="grid gap-1"><Label>Senha</Label>
                <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="font-mono" /></div>
            </div>
          </div>
          <DialogFooter><Button onClick={save} disabled={saving}>{saving ? "Salvando..." : "Salvar e gerar script"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!script} onOpenChange={(o) => !o && setScript(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Terminal className="h-4 w-4" /> Script para o MikroTik</DialogTitle>
            <DialogDescription>Cole no terminal do Winbox. Ele cria um usuário somente leitura e libera a API apenas para a VPN.</DialogDescription>
          </DialogHeader>
          <Textarea readOnly value={script ?? ""} className="h-72 font-mono text-xs" />
          <DialogFooter>
            <Button className="gap-2" onClick={() => { navigator.clipboard.writeText(script ?? ""); toast.success("Copiado"); }}>
              <Copy className="h-4 w-4" /> Copiar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
