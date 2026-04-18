import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { StatusBadge } from "@/components/StatusBadge";

const schema = z.object({
  nome: z.string().trim().min(1, "Nome obrigatório").max(120),
  host: z.string().trim().min(1, "Host/IP obrigatório").max(255),
  modelo: z.string().trim().max(120).optional().or(z.literal("")),
  observacoes: z.string().trim().max(500).optional().or(z.literal("")),
});

type FormData = z.infer<typeof schema>;
const empty: FormData = { nome: "", host: "", modelo: "", observacoes: "" };

export default function AdminConcentradores() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-concentradores"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("concentradores")
        .select("*")
        .order("nome");
      if (error) throw error;
      return data;
    },
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(empty);
    setErrors({});
    setOpen(true);
  };

  const openEdit = (row: { id: string; nome: string; host: string; modelo: string | null; observacoes: string | null }) => {
    setEditingId(row.id);
    setForm({
      nome: row.nome,
      host: row.host,
      modelo: row.modelo ?? "",
      observacoes: row.observacoes ?? "",
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
    const payload = {
      nome: parsed.data.nome,
      host: parsed.data.host,
      modelo: parsed.data.modelo || null,
      observacoes: parsed.data.observacoes || null,
    };
    const op = editingId
      ? supabase.from("concentradores").update(payload).eq("id", editingId)
      : supabase.from("concentradores").insert(payload);
    const { error } = await op;
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar", { description: error.message });
      return;
    }
    toast.success(editingId ? "Concentrador atualizado" : "Concentrador cadastrado");
    setOpen(false);
    qc.invalidateQueries({ queryKey: ["admin-concentradores"] });
    qc.invalidateQueries({ queryKey: ["concentradores"] });
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    const { error } = await supabase.from("concentradores").delete().eq("id", deleteId);
    if (error) {
      toast.error("Erro ao excluir", { description: error.message });
    } else {
      toast.success("Concentrador removido");
      qc.invalidateQueries({ queryKey: ["admin-concentradores"] });
      qc.invalidateQueries({ queryKey: ["concentradores"] });
    }
    setDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cadastre concentradores manualmente. O agente coletor faz upsert pelo campo <code className="text-xs">host</code>.
        </p>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-2 h-4 w-4" /> Novo concentrador
        </Button>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Modelo</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Online</TableHead>
              <TableHead className="w-24 text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>
            )}
            {!isLoading && data?.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Nenhum concentrador cadastrado.</TableCell></TableRow>
            )}
            {data?.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.nome}</TableCell>
                <TableCell className="font-mono text-xs">{c.host}</TableCell>
                <TableCell className="text-muted-foreground">{c.modelo ?? "—"}</TableCell>
                <TableCell><StatusBadge status={c.status} /></TableCell>
                <TableCell className="font-mono text-sm">{c.usuarios_online}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(c)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteId(c.id)}>
                    <Trash2 className="h-4 w-4 text-status-offline" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar concentrador" : "Novo concentrador"}</DialogTitle>
            <DialogDescription>Os dados de telemetria são preenchidos pelo agente coletor.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nome *</Label>
              <Input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
              {errors.nome && <p className="text-xs text-destructive">{errors.nome}</p>}
            </div>
            <div className="space-y-1">
              <Label>Host / IP *</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.0.0.1" />
              {errors.host && <p className="text-xs text-destructive">{errors.host}</p>}
            </div>
            <div className="space-y-1">
              <Label>Modelo</Label>
              <Input value={form.modelo} onChange={(e) => setForm({ ...form, modelo: e.target.value })} placeholder="CCR2004-1G-12S+2XS" />
            </div>
            <div className="space-y-1">
              <Label>Observações</Label>
              <Textarea value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover concentrador?</AlertDialogTitle>
            <AlertDialogDescription>
              Sessões PPPoE e eventos vinculados serão mantidos no histórico, mas perderão a referência. Esta ação é irreversível.
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
