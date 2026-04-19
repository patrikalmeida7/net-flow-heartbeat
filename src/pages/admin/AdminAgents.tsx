import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Copy, CheckCircle2, AlertCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function genToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default function AdminAgents() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ nome: "", descricao: "" });
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-agents"],
    queryFn: async () => {
      const { data, error } = await supabase.from("agents").select("*").order("nome");
      if (error) throw error;
      return data;
    },
  });

  const create = async () => {
    if (!form.nome.trim()) {
      toast.error("Nome obrigatório");
      return;
    }
    setSaving(true);
    const token = genToken();
    const token_hash = await sha256Hex(token);
    const { error } = await supabase.from("agents").insert({
      nome: form.nome.trim(),
      descricao: form.descricao.trim() || null,
      token_hash,
    });
    setSaving(false);
    if (error) {
      toast.error("Erro ao criar agente", { description: error.message });
      return;
    }
    setGeneratedToken(token);
    qc.invalidateQueries({ queryKey: ["admin-agents"] });
    qc.invalidateQueries({ queryKey: ["vpn-agents-list"] });
  };

  const closeDialog = () => {
    setOpen(false);
    setForm({ nome: "", descricao: "" });
    setGeneratedToken(null);
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    const { error } = await supabase.from("agents").delete().eq("id", deleteId);
    if (error) toast.error("Erro ao excluir", { description: error.message });
    else {
      toast.success("Agente removido");
      qc.invalidateQueries({ queryKey: ["admin-agents"] });
    }
    setDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Agentes Node.js que rodam na sua infra (VM Linux) e mantêm os túneis VPN ativos.
        </p>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-2 h-4 w-4" /> Novo agente
        </Button>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Última conexão</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Versão</TableHead>
              <TableHead className="w-16 text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>}
            {!isLoading && data?.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Nenhum agente cadastrado.</TableCell></TableRow>
            )}
            {data?.map((a) => {
              const recent = a.last_seen_at && Date.now() - new Date(a.last_seen_at).getTime() < 60_000;
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <div className="font-medium">{a.nome}</div>
                    {a.descricao && <div className="text-xs text-muted-foreground">{a.descricao}</div>}
                  </TableCell>
                  <TableCell>
                    {recent ? (
                      <Badge variant="outline" className="border-status-online/40 text-status-online">
                        <CheckCircle2 className="mr-1 h-3 w-3" /> Online
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-status-offline/40 text-status-offline">
                        <AlertCircle className="mr-1 h-3 w-3" /> Offline
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{timeAgo(a.last_seen_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.last_ip ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{a.version ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" onClick={() => setDeleteId(a.id)}>
                      <Trash2 className="h-4 w-4 text-status-offline" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{generatedToken ? "Token gerado" : "Novo agente"}</DialogTitle>
            <DialogDescription>
              {generatedToken
                ? "Copie o token AGORA. Ele não será mostrado novamente — só guardamos um hash."
                : "Crie um agente para rodar os túneis VPN na sua infra."}
            </DialogDescription>
          </DialogHeader>

          {!generatedToken ? (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>Nome *</Label>
                <Input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="agent-noc-01" />
              </div>
              <div className="space-y-1">
                <Label>Descrição</Label>
                <Textarea value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} rows={2} />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm">
                ⚠️ Salve este token agora. Ele só aparece uma vez.
              </div>
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <code className="break-all font-mono text-xs">{generatedToken}</code>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(generatedToken);
                  toast.success("Token copiado");
                }}
              >
                <Copy className="mr-2 h-3 w-3" /> Copiar token
              </Button>
              <p className="text-xs text-muted-foreground">
                Configure no agente: <code className="rounded bg-muted px-1">VPN_AGENT_TOKEN={"<token>"}</code>
              </p>
            </div>
          )}

          <DialogFooter>
            {!generatedToken ? (
              <>
                <Button variant="outline" onClick={closeDialog}>Cancelar</Button>
                <Button onClick={create} disabled={saving}>{saving ? "Criando…" : "Criar e gerar token"}</Button>
              </>
            ) : (
              <Button onClick={closeDialog}>Fechar</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover agente?</AlertDialogTitle>
            <AlertDialogDescription>
              Túneis vinculados a este agente ficarão sem agente responsável. Esta ação é irreversível.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
