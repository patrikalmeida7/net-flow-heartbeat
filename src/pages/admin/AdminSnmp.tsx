import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Power, PowerOff, Trash2, Pencil } from "lucide-react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/hooks/use-toast";
import { timeAgo } from "@/lib/format";

const KEY = ["admin", "snmp"] as const;

type Cred = {
  id: string;
  concentrador_id: string | null;
  rbs_id: string | null;
  enabled: boolean;
  version: "v2c" | "v3";
  port: number;
  community: string | null;
  username: string | null;
  auth_proto: "none" | "MD5" | "SHA";
  auth_password: string | null;
  priv_proto: "none" | "DES" | "AES";
  priv_password: string | null;
  poll_interval_seconds: number;
  timeout_ms: number;
  retries: number;
  last_poll_at: string | null;
  last_error: string | null;
};

const formSchema = z.object({
  target_kind: z.enum(["concentrador", "rbs"]),
  target_id: z.string().uuid("Selecione um equipamento"),
  enabled: z.boolean(),
  version: z.enum(["v2c", "v3"]),
  port: z.coerce.number().int().min(1).max(65535),
  community: z.string().optional(),
  username: z.string().optional(),
  auth_proto: z.enum(["none", "MD5", "SHA"]),
  auth_password: z.string().optional(),
  priv_proto: z.enum(["none", "DES", "AES"]),
  priv_password: z.string().optional(),
  poll_interval_seconds: z.coerce.number().int().min(5).max(3600),
  timeout_ms: z.coerce.number().int().min(500).max(30000),
  retries: z.coerce.number().int().min(0).max(10),
});

type FormValues = z.infer<typeof formSchema>;

const blank: FormValues = {
  target_kind: "concentrador",
  target_id: "",
  enabled: true,
  version: "v2c",
  port: 161,
  community: "public",
  username: "",
  auth_proto: "none",
  auth_password: "",
  priv_proto: "none",
  priv_password: "",
  poll_interval_seconds: 30,
  timeout_ms: 3000,
  retries: 2,
};

async function fetchAll() {
  const [creds, concs, rbs] = await Promise.all([
    supabase.from("snmp_credentials").select("*").order("created_at", { ascending: false }),
    supabase.from("concentradores").select("id, nome, host").order("nome"),
    supabase.from("rbs").select("id, nome, host").order("nome"),
  ]);
  return {
    creds: (creds.data ?? []) as Cred[],
    concs: concs.data ?? [],
    rbs: rbs.data ?? [],
  };
}

export default function AdminSnmp() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: fetchAll });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Cred | null>(null);
  const [form, setForm] = useState<FormValues>(blank);

  const concById = new Map((data?.concs ?? []).map((c) => [c.id, c]));
  const rbsById = new Map((data?.rbs ?? []).map((r) => [r.id, r]));

  const openNew = () => {
    setEditing(null);
    setForm(blank);
    setOpen(true);
  };
  const openEdit = (c: Cred) => {
    setEditing(c);
    setForm({
      target_kind: c.concentrador_id ? "concentrador" : "rbs",
      target_id: (c.concentrador_id ?? c.rbs_id)!,
      enabled: c.enabled,
      version: c.version,
      port: c.port,
      community: c.community ?? "",
      username: c.username ?? "",
      auth_proto: c.auth_proto,
      auth_password: c.auth_password ?? "",
      priv_proto: c.priv_proto,
      priv_password: c.priv_password ?? "",
      poll_interval_seconds: c.poll_interval_seconds,
      timeout_ms: c.timeout_ms,
      retries: c.retries,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: async (values: FormValues) => {
      const parsed = formSchema.parse(values);
      const row = {
        concentrador_id: parsed.target_kind === "concentrador" ? parsed.target_id : null,
        rbs_id: parsed.target_kind === "rbs" ? parsed.target_id : null,
        enabled: parsed.enabled,
        version: parsed.version,
        port: parsed.port,
        community: parsed.version === "v2c" ? parsed.community || null : null,
        username: parsed.version === "v3" ? parsed.username || null : null,
        auth_proto: parsed.version === "v3" ? parsed.auth_proto : "none",
        auth_password: parsed.version === "v3" && parsed.auth_proto !== "none" ? parsed.auth_password || null : null,
        priv_proto: parsed.version === "v3" ? parsed.priv_proto : "none",
        priv_password: parsed.version === "v3" && parsed.priv_proto !== "none" ? parsed.priv_password || null : null,
        poll_interval_seconds: parsed.poll_interval_seconds,
        timeout_ms: parsed.timeout_ms,
        retries: parsed.retries,
      };
      if (editing) {
        const { error } = await supabase.from("snmp_credentials").update(row).eq("id", editing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("snmp_credentials").insert(row);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast({ title: "Salvo" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("snmp_credentials").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Removido" });
      qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: Error) => toast({ title: "Erro", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Credenciais SNMP</h2>
          <p className="text-sm text-muted-foreground">
            Configure SNMP por equipamento. O agente local usa essas credenciais para coletar métricas detalhadas.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={openNew} className="gap-2">
              <Plus className="h-4 w-4" /> Nova credencial
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{editing ? "Editar credencial SNMP" : "Nova credencial SNMP"}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Tipo de equipamento</Label>
                <Select
                  value={form.target_kind}
                  onValueChange={(v: "concentrador" | "rbs") => setForm({ ...form, target_kind: v, target_id: "" })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="concentrador">Concentrador</SelectItem>
                    <SelectItem value="rbs">RBS / Torre</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>Equipamento</Label>
                <Select value={form.target_id} onValueChange={(v) => setForm({ ...form, target_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Selecione…" /></SelectTrigger>
                  <SelectContent>
                    {(form.target_kind === "concentrador" ? data?.concs : data?.rbs)?.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.nome} {d.host ? `· ${d.host}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Versão</Label>
                <Select value={form.version} onValueChange={(v: "v2c" | "v3") => setForm({ ...form, version: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="v2c">SNMPv2c</SelectItem>
                    <SelectItem value="v3">SNMPv3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Porta</Label>
                <Input type="number" value={form.port} onChange={(e) => setForm({ ...form, port: Number(e.target.value) })} />
              </div>

              {form.version === "v2c" ? (
                <div className="col-span-2">
                  <Label>Community</Label>
                  <Input value={form.community} onChange={(e) => setForm({ ...form, community: e.target.value })} />
                </div>
              ) : (
                <>
                  <div className="col-span-2">
                    <Label>Usuário</Label>
                    <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  </div>
                  <div>
                    <Label>Auth</Label>
                    <Select value={form.auth_proto} onValueChange={(v: "none" | "MD5" | "SHA") => setForm({ ...form, auth_proto: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Nenhum</SelectItem>
                        <SelectItem value="MD5">MD5</SelectItem>
                        <SelectItem value="SHA">SHA</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Senha auth</Label>
                    <Input
                      type="password"
                      value={form.auth_password}
                      onChange={(e) => setForm({ ...form, auth_password: e.target.value })}
                      disabled={form.auth_proto === "none"}
                    />
                  </div>
                  <div>
                    <Label>Priv</Label>
                    <Select value={form.priv_proto} onValueChange={(v: "none" | "DES" | "AES") => setForm({ ...form, priv_proto: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Nenhum</SelectItem>
                        <SelectItem value="DES">DES</SelectItem>
                        <SelectItem value="AES">AES</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Senha priv</Label>
                    <Input
                      type="password"
                      value={form.priv_password}
                      onChange={(e) => setForm({ ...form, priv_password: e.target.value })}
                      disabled={form.priv_proto === "none"}
                    />
                  </div>
                </>
              )}

              <div>
                <Label>Intervalo (s)</Label>
                <Input type="number" value={form.poll_interval_seconds}
                  onChange={(e) => setForm({ ...form, poll_interval_seconds: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Timeout (ms)</Label>
                <Input type="number" value={form.timeout_ms}
                  onChange={(e) => setForm({ ...form, timeout_ms: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Retries</Label>
                <Input type="number" value={form.retries}
                  onChange={(e) => setForm({ ...form, retries: Number(e.target.value) })} />
              </div>
              <div className="col-span-2 flex items-center gap-2 pt-2">
                <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                <Label>Coleta habilitada</Label>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
              <Button onClick={() => save.mutate(form)} disabled={save.isPending}>
                {save.isPending ? "Salvando…" : "Salvar"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Equipamento</th>
              <th className="px-3 py-2 text-left">Versão</th>
              <th className="px-3 py-2 text-left">Intervalo</th>
              <th className="px-3 py-2 text-left">Última coleta</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {(data?.creds ?? []).map((c) => {
              const dev = c.concentrador_id ? concById.get(c.concentrador_id) : rbsById.get(c.rbs_id!);
              return (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{dev?.nome ?? "—"}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {c.concentrador_id ? "Concentrador" : "RBS"} · {dev?.host ?? "—"}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs uppercase">{c.version}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.poll_interval_seconds}s</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{timeAgo(c.last_poll_at)}</td>
                  <td className="px-3 py-2">
                    {!c.enabled ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <PowerOff className="h-3 w-3" /> desabilitado
                      </span>
                    ) : c.last_error ? (
                      <span className="text-xs text-status-offline" title={c.last_error}>
                        erro
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-status-online">
                        <Power className="h-3 w-3" /> ok
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" size="icon" onClick={() => openEdit(c)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm("Remover credencial?")) del.mutate(c.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {(data?.creds ?? []).length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-sm text-muted-foreground">
                Nenhuma credencial SNMP cadastrada.
              </td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
