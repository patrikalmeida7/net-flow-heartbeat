import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Trash2, AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { timeAgo } from "@/lib/format";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

interface FormState {
  agent_id: string;
  nome: string;
  internal_ip: string;
  email: string;
  observacoes: string;
}

const emptyForm: FormState = {
  agent_id: "",
  nome: "",
  internal_ip: "",
  email: "",
  observacoes: "",
};

const NAME_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function statusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" /> Aguardando
        </Badge>
      );
    case "provisioning":
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="h-3 w-3 animate-spin" /> Provisionando
        </Badge>
      );
    case "active":
      return (
        <Badge variant="default" className="gap-1">
          <CheckCircle2 className="h-3 w-3" /> Ativo
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="h-3 w-3" /> Falhou
        </Badge>
      );
    case "removed":
      return <Badge variant="outline">Removido</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function AdminVpnClients() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Realtime: status muda quando o agente reporta
  useRealtimeInvalidate("vpn_clients", ["vpn_clients"]);

  const agentsQuery = useQuery({
    queryKey: ["agents-enabled"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("agents")
        .select("id, nome, enabled")
        .eq("enabled", true)
        .order("nome");
      if (error) throw error;
      return data ?? [];
    },
  });

  const clientsQuery = useQuery({
    queryKey: ["vpn_clients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vpn_clients")
        .select("*, agents:agent_id(nome)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  function resetForm() {
    setForm(emptyForm);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.agent_id) {
      toast.error("Selecione o agente que vai criar o cliente.");
      return;
    }
    if (!NAME_RE.test(form.nome)) {
      toast.error("Nome inválido. Use apenas letras, números, hífen e underscore (2-64 caracteres).");
      return;
    }
    if (!IP_RE.test(form.internal_ip)) {
      toast.error("IP interno inválido (formato esperado: 10.100.0.10).");
      return;
    }
    if (form.email && !/^\S+@\S+\.\S+$/.test(form.email)) {
      toast.error("Email inválido.");
      return;
    }

    setSubmitting(true);
    try {
      const { error } = await supabase.from("vpn_clients").insert({
        agent_id: form.agent_id,
        nome: form.nome.trim(),
        internal_ip: form.internal_ip.trim(),
        email: form.email.trim() || null,
        observacoes: form.observacoes.trim() || null,
        status: "pending" as const,
      });
      if (error) throw error;
      toast.success("Cliente enfileirado. O agente vai criar em segundos.");
      setDialogOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["vpn_clients"] });
    } catch (err: any) {
      toast.error(`Falha: ${err.message ?? err}`);
    } finally {
      setSubmitting(false);
    }
  }

  async function onResend(id: string) {
    try {
      const { error } = await supabase.functions.invoke("vpn-clients-resend", {
        body: { client_id: id },
      });
      if (error) throw error;
      toast.success("Reenviado para a fila.");
      queryClient.invalidateQueries({ queryKey: ["vpn_clients"] });
    } catch (err: any) {
      toast.error(`Falha: ${err.message ?? err}`);
    }
  }

  async function onDelete() {
    if (!deleteId) return;
    try {
      const { error } = await supabase.from("vpn_clients").delete().eq("id", deleteId);
      if (error) throw error;
      toast.success("Cliente removido do registro.");
      queryClient.invalidateQueries({ queryKey: ["vpn_clients"] });
    } catch (err: any) {
      toast.error(`Falha: ${err.message ?? err}`);
    } finally {
      setDeleteId(null);
    }
  }

  const clients = clientsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Clientes VPN</h2>
          <p className="text-sm text-muted-foreground">
            Cadastre um cliente e o agente roda <code className="text-xs">noc-add-client</code> automaticamente
            na VPS. Atualização ao vivo.
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <Button onClick={() => setDialogOpen(true)} size="sm" className="gap-2">
            <Plus className="h-4 w-4" /> Novo cliente
          </Button>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Cadastrar cliente VPN</DialogTitle>
              <DialogDescription>
                Será enfileirado para o agente executar <code>noc-add-client</code> na VPS.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="agent">Agente</Label>
                <Select
                  value={form.agent_id}
                  onValueChange={(v) => setForm({ ...form, agent_id: v })}
                >
                  <SelectTrigger id="agent">
                    <SelectValue placeholder="Selecione o agente da VPS..." />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.nome}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nome">Nome do cliente</Label>
                <Input
                  id="nome"
                  value={form.nome}
                  onChange={(e) => setForm({ ...form, nome: e.target.value })}
                  placeholder="ex: cliente-acme"
                  maxLength={64}
                  required
                />
                <p className="text-xs text-muted-foreground">Letras, números, hífen e underscore.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ip">IP interno WireGuard</Label>
                <Input
                  id="ip"
                  value={form.internal_ip}
                  onChange={(e) => setForm({ ...form, internal_ip: e.target.value })}
                  placeholder="10.100.0.10"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email (opcional, para envio do .conf)</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="cliente@empresa.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="obs">Observações</Label>
                <Textarea
                  id="obs"
                  value={form.observacoes}
                  onChange={(e) => setForm({ ...form, observacoes: e.target.value })}
                  rows={2}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Enfileirando..." : "Criar"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cliente</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Agente</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tentativas</TableHead>
              <TableHead>Provisionado</TableHead>
              <TableHead className="text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clientsQuery.isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                  Carregando...
                </TableCell>
              </TableRow>
            )}
            {!clientsQuery.isLoading && clients.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                  Nenhum cliente cadastrado ainda.
                </TableCell>
              </TableRow>
            )}
            {clients.map((c: any) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">
                  {c.nome}
                  {c.email && <div className="text-xs text-muted-foreground">{c.email}</div>}
                </TableCell>
                <TableCell className="font-mono text-xs">{c.internal_ip}</TableCell>
                <TableCell className="text-sm">{c.agents?.nome ?? "-"}</TableCell>
                <TableCell>
                  {statusBadge(c.status)}
                  {c.last_error && (
                    <div className="text-xs text-destructive mt-1 max-w-xs truncate" title={c.last_error}>
                      {c.last_error}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-sm">{c.attempts ?? 0}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {c.provisioned_at ? timeAgo(c.provisioned_at) : "-"}
                </TableCell>
                <TableCell className="text-right space-x-1">
                  {(c.status === "failed" || c.status === "active") && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onResend(c.id)}
                      title="Recriar na fila"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDeleteId(c.id)}
                    title="Remover do registro"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover cliente do registro?</AlertDialogTitle>
            <AlertDialogDescription>
              Isso só apaga o registro no painel. Para remover o peer da VPN na VPS, rode
              <code className="mx-1">noc-remove-client</code> manualmente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
