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
  host: z.string().trim().max(255).optional().or(z.literal("")),
  endereco: z.string().trim().max(255).optional().or(z.literal("")),
  latitude: z.string().trim().optional().or(z.literal("")),
  longitude: z.string().trim().optional().or(z.literal("")),
  observacoes: z.string().trim().max(500).optional().or(z.literal("")),
});

type FormData = z.infer<typeof schema>;
const empty: FormData = { nome: "", host: "", endereco: "", latitude: "", longitude: "", observacoes: "" };

export default function AdminRBS() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-rbs"],
    queryFn: async () => {
      const { data, error } = await supabase.from("rbs").select("*").order("nome");
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

  const openEdit = (row: typeof data extends Array<infer R> ? R : never) => {
    setEditingId(row.id);
    setForm({
      nome: row.nome,
      host: row.host ?? "",
      endereco: row.endereco ?? "",
      latitude: row.latitude != null ? String(row.latitude) : "",
      longitude: row.longitude != null ? String(row.longitude) : "",
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
    const lat = parsed.data.latitude ? Number(parsed.data.latitude) : null;
    const lng = parsed.data.longitude ? Number(parsed.data.longitude) : null;
    if (parsed.data.latitude && (Number.isNaN(lat!) || lat! < -90 || lat! > 90)) {
      setErrors({ latitude: "Latitude inválida (-90 a 90)" });
      return;
    }
    if (parsed.data.longitude && (Number.isNaN(lng!) || lng! < -180 || lng! > 180)) {
      setErrors({ longitude: "Longitude inválida (-180 a 180)" });
      return;
    }
    setSaving(true);
    const payload = {
      nome: parsed.data.nome,
      host: parsed.data.host || null,
      endereco: parsed.data.endereco || null,
      latitude: lat,
      longitude: lng,
      observacoes: parsed.data.observacoes || null,
    };
    const op = editingId
      ? supabase.from("rbs").update(payload).eq("id", editingId)
      : supabase.from("rbs").insert(payload);
    const { error } = await op;
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar", { description: error.message });
      return;
    }
    toast.success(editingId ? "RBS atualizada" : "RBS cadastrada");
    setOpen(false);
    qc.invalidateQueries({ queryKey: ["admin-rbs"] });
    qc.invalidateQueries({ queryKey: ["rbs"] });
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    const { error } = await supabase.from("rbs").delete().eq("id", deleteId);
    if (error) {
      toast.error("Erro ao excluir", { description: error.message });
    } else {
      toast.success("RBS removida");
      qc.invalidateQueries({ queryKey: ["admin-rbs"] });
      qc.invalidateQueries({ queryKey: ["rbs"] });
    }
    setDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Cadastre torres/RBS. Latitude e longitude habilitam visualização em mapa.
        </p>
        <Button onClick={openCreate} size="sm">
          <Plus className="mr-2 h-4 w-4" /> Nova RBS
        </Button>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Endereço</TableHead>
              <TableHead>Coordenadas</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-24 text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>
            )}
            {!isLoading && data?.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">Nenhuma RBS cadastrada.</TableCell></TableRow>
            )}
            {data?.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.nome}</TableCell>
                <TableCell className="font-mono text-xs">{r.host ?? "—"}</TableCell>
                <TableCell className="max-w-[200px] truncate text-muted-foreground">{r.endereco ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {r.latitude != null && r.longitude != null ? `${r.latitude}, ${r.longitude}` : "—"}
                </TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(r)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteId(r.id)}>
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
            <DialogTitle>{editingId ? "Editar RBS" : "Nova RBS"}</DialogTitle>
            <DialogDescription>Cadastro manual de torre / estação rádio-base.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Nome *</Label>
              <Input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="RBS-CENTRO" />
              {errors.nome && <p className="text-xs text-destructive">{errors.nome}</p>}
            </div>
            <div className="space-y-1">
              <Label>Host / IP de gerência</Label>
              <Input value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="10.10.0.5" />
            </div>
            <div className="space-y-1">
              <Label>Endereço</Label>
              <Input value={form.endereco} onChange={(e) => setForm({ ...form, endereco: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Latitude</Label>
                <Input value={form.latitude} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="-23.5505" />
                {errors.latitude && <p className="text-xs text-destructive">{errors.latitude}</p>}
              </div>
              <div className="space-y-1">
                <Label>Longitude</Label>
                <Input value={form.longitude} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="-46.6333" />
                {errors.longitude && <p className="text-xs text-destructive">{errors.longitude}</p>}
              </div>
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
            <AlertDialogTitle>Remover RBS?</AlertDialogTitle>
            <AlertDialogDescription>Esta ação é irreversível.</AlertDialogDescription>
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
