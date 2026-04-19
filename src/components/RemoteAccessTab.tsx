import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { AlertTriangle, Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { timeAgo } from "@/lib/format";

const schema = z.object({
  host: z.string().trim().min(1, "Host obrigatório").max(255),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().min(1, "Usuário obrigatório").max(120),
  password: z.string().min(1, "Senha obrigatória").max(255),
  observacoes: z.string().trim().max(500).optional().or(z.literal("")),
  enabled: z.boolean(),
});
type FormData = z.input<typeof schema>;

type Props =
  | { kind: "concentrador"; deviceId: string; defaultHost?: string | null }
  | { kind: "rbs"; deviceId: string; defaultHost?: string | null };

const empty = (host?: string | null): FormData => ({
  host: host ?? "",
  port: 22,
  username: "admin",
  password: "",
  observacoes: "",
  enabled: true,
});

export default function RemoteAccessTab(props: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormData>(empty(props.defaultHost));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [polling, setPolling] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  const credKey = ["device-credential", props.kind, props.deviceId] as const;
  const { data: cred, isLoading } = useQuery({
    queryKey: credKey,
    queryFn: async () => {
      const filter = props.kind === "concentrador" ? { concentrador_id: props.deviceId } : { rbs_id: props.deviceId };
      const { data, error } = await supabase
        .from("device_credentials")
        .select("id, host, port, username, protocol, enabled, observacoes, last_poll_at, last_error")
        .match(filter)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const pollsKey = ["device-ssh-polls", cred?.id] as const;
  const { data: lastPoll } = useQuery({
    queryKey: pollsKey,
    enabled: !!cred?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("device_ssh_polls")
        .select("*")
        .eq("credential_id", cred!.id)
        .order("collected_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const openCreate = () => {
    setForm(empty(props.defaultHost));
    setErrors({});
    setOpen(true);
  };

  const openEdit = () => {
    if (!cred) return;
    setForm({
      host: cred.host,
      port: cred.port,
      username: cred.username,
      password: "",
      observacoes: cred.observacoes ?? "",
      enabled: cred.enabled,
    });
    setErrors({});
    setOpen(true);
  };

  const save = async () => {
    const parsed = schema.safeParse(form);
    if (!parsed.success) {
      setErrors(Object.fromEntries(Object.entries(parsed.error.flatten().fieldErrors).map(([k, v]) => [k, v?.[0] ?? ""])));
      return;
    }
    setSaving(true);
    try {
      let credentialId = cred?.id;
      if (cred) {
        const { error } = await supabase
          .from("device_credentials")
          .update({
            host: parsed.data.host,
            port: parsed.data.port,
            username: parsed.data.username,
            observacoes: parsed.data.observacoes || null,
            enabled: parsed.data.enabled,
          })
          .eq("id", cred.id);
        if (error) throw error;
      } else {
        const insertRow = {
          [props.kind === "concentrador" ? "concentrador_id" : "rbs_id"]: props.deviceId,
          protocol: "ssh" as const,
          host: parsed.data.host,
          port: parsed.data.port,
          username: parsed.data.username,
          observacoes: parsed.data.observacoes || null,
          enabled: parsed.data.enabled,
          // Os bytea são exigidos pelo schema; gravamos placeholders e a senha real
          // entra logo abaixo via RPC set_device_credential_password.
          password_encrypted: "\\x00",
          password_nonce: "\\x00",
        };
        const { data, error } = await supabase
          .from("device_credentials")
          .insert(insertRow)
          .select("id")
          .single();
        if (error) throw error;
        credentialId = data.id;
      }
      // Se foi digitada uma senha (sempre obrigatória na criação, opcional na edição),
      // grava criptografada via RPC.
      if (parsed.data.password) {
        const { error: pwdErr } = await supabase.rpc("set_device_credential_password", {
          _credential_id: credentialId!,
          _password: parsed.data.password,
        });
        if (pwdErr) throw pwdErr;
      }
      toast.success(cred ? "Credencial atualizada" : "Credencial cadastrada");
      setOpen(false);
      qc.invalidateQueries({ queryKey: credKey });
    } catch (e) {
      toast.error("Erro ao salvar", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!cred) return;
    const { error } = await supabase.from("device_credentials").delete().eq("id", cred.id);
    if (error) toast.error("Erro ao remover", { description: error.message });
    else {
      toast.success("Credencial removida");
      qc.invalidateQueries({ queryKey: credKey });
    }
    setConfirmDel(false);
  };

  const collect = async () => {
    if (!cred) return;
    setPolling(true);
    try {
      const { data, error } = await supabase.functions.invoke("device-ssh-monitor", {
        body: { credential_id: cred.id },
      });
      if (error) throw error;
      if (data?.success) toast.success(`Coleta concluída em ${data.duration_ms}ms`);
      else toast.error("Coleta falhou", { description: data?.error ?? "erro desconhecido" });
      qc.invalidateQueries({ queryKey: pollsKey });
      qc.invalidateQueries({ queryKey: credKey });
    } catch (e) {
      toast.error("Erro na coleta", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setPolling(false);
    }
  };

  const onEditPassword = () => {
    setForm({ ...form, password: "" });
    if (cred) openEdit();
    else openCreate();
  };

  return (
    <div className="space-y-4">
      <Card className="border-warning/40 bg-warning/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div className="space-y-1 text-sm">
            <p className="font-medium">Atenção: SSH exposto à internet</p>
            <p className="text-muted-foreground">
              Esta funcionalidade conecta no equipamento a partir da nuvem. O MikroTik precisa ter a porta SSH
              acessível pela internet pública. Considere restringir por firewall/IP de origem.
            </p>
          </div>
        </div>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : !cred ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-muted-foreground">Nenhuma credencial cadastrada para este equipamento.</p>
          <Button onClick={openCreate} className="mt-3" size="sm">
            <Plus className="mr-2 h-4 w-4" /> Cadastrar credencial SSH
          </Button>
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{cred.host}:{cred.port}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs uppercase">{cred.protocol}</span>
                  {!cred.enabled && (
                    <span className="rounded bg-status-offline/20 px-1.5 py-0.5 text-xs text-status-offline">desabilitada</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  Usuário <span className="font-mono">{cred.username}</span> · senha criptografada (pgsodium)
                </p>
                <p className="text-xs text-muted-foreground">
                  Última coleta: {cred.last_poll_at ? timeAgo(cred.last_poll_at) : "nunca"}
                  {cred.last_error && <span className="ml-2 text-status-offline">erro: {cred.last_error}</span>}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button onClick={collect} size="sm" disabled={polling || !cred.enabled}>
                  <RefreshCw className={`mr-2 h-4 w-4 ${polling ? "animate-spin" : ""}`} />
                  {polling ? "Coletando…" : "Coletar agora"}
                </Button>
                <Button variant="ghost" size="icon" onClick={onEditPassword}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setConfirmDel(true)}>
                  <Trash2 className="h-4 w-4 text-status-offline" />
                </Button>
              </div>
            </div>
          </Card>

          {lastPoll && (
            <Card className="p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-medium">
                  Resultado: {timeAgo(lastPoll.collected_at)} · {lastPoll.duration_ms}ms ·
                  <span className={lastPoll.success ? "ml-1 text-status-online" : "ml-1 text-status-offline"}>
                    {lastPoll.success ? "sucesso" : "falha"}
                  </span>
                </p>
              </div>
              {!lastPoll.success && lastPoll.error && (
                <p className="mb-3 rounded bg-status-offline/10 p-2 text-xs text-status-offline">{lastPoll.error}</p>
              )}
              <div className="space-y-3">
                {Object.entries((lastPoll.results ?? {}) as Record<string, { cmd: string; stdout: string; stderr: string; exit_code: number | null }>).map(([key, res]) => (
                  <div key={key} className="rounded border border-border">
                    <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
                      <span className="font-mono text-xs">{res.cmd}</span>
                      <span className="text-xs text-muted-foreground">exit {res.exit_code ?? "—"}</span>
                    </div>
                    <pre className="max-h-64 overflow-auto bg-background p-3 font-mono text-xs leading-relaxed">
                      {res.stdout || res.stderr || "(sem saída)"}
                    </pre>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{cred ? "Editar credencial" : "Nova credencial SSH"}</DialogTitle>
            <DialogDescription>
              Senha guardada criptografada (pgsodium). Deixe em branco ao editar para manter a senha atual.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <Label>Host *</Label>
                <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.0.0.1" />
                {errors.host && <p className="text-xs text-destructive">{errors.host}</p>}
              </div>
              <div className="space-y-1">
                <Label>Porta *</Label>
                <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
                {errors.port && <p className="text-xs text-destructive">{errors.port}</p>}
              </div>
            </div>
            <div className="space-y-1">
              <Label>Usuário *</Label>
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
              {errors.username && <p className="text-xs text-destructive">{errors.username}</p>}
            </div>
            <div className="space-y-1">
              <Label>{cred ? "Nova senha (deixe vazio para manter)" : "Senha *"}</Label>
              <div className="relative">
                <Input
                  type={showPwd ? "text" : "password"}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  autoComplete="new-password"
                />
                <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0" onClick={() => setShowPwd(!showPwd)}>
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              {errors.password && !cred && <p className="text-xs text-destructive">{errors.password}</p>}
            </div>
            <div className="space-y-1">
              <Label>Observações</Label>
              <Textarea rows={2} value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} />
            </div>
            <div className="flex items-center justify-between rounded border border-border p-3">
              <div className="text-sm">
                <p className="font-medium">Credencial ativa</p>
                <p className="text-xs text-muted-foreground">Desabilite para pausar coletas sem apagar.</p>
              </div>
              <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDel} onOpenChange={setConfirmDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover credencial?</AlertDialogTitle>
            <AlertDialogDescription>
              A senha criptografada e o histórico de coletas serão apagados. Esta ação é irreversível.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
