import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Power, PowerOff, History } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { timeAgo } from "@/lib/format";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

type Protocol = "wireguard" | "openvpn";

interface FormState {
  nome: string;
  protocol: Protocol;
  agent_id: string;
  endpoint_host: string;
  endpoint_port: string;
  grupo: string;
  observacoes: string;
  // wg
  wg_peer_public_key: string;
  wg_address_cidr: string;
  wg_allowed_ips: string;
  wg_dns: string;
  wg_persistent_keepalive: string;
  wg_private_key: string;
  wg_preshared_key: string;
  // ovpn
  ovpn_config: string;
  ovpn_username: string;
  ovpn_password: string;
}

const emptyForm: FormState = {
  nome: "",
  protocol: "wireguard",
  agent_id: "",
  endpoint_host: "",
  endpoint_port: "51820",
  grupo: "",
  observacoes: "",
  wg_peer_public_key: "",
  wg_address_cidr: "",
  wg_allowed_ips: "",
  wg_dns: "",
  wg_persistent_keepalive: "25",
  wg_private_key: "",
  wg_preshared_key: "",
  ovpn_config: "",
  ovpn_username: "",
  ovpn_password: "",
};

export default function AdminVpn() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [eventsFor, setEventsFor] = useState<{ id: string; nome: string } | null>(null);

  useRealtimeInvalidate("vpn_status", ["admin-vpn"]);

  const { data: agents } = useQuery({
    queryKey: ["vpn-agents-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("agents").select("id, nome").order("nome");
      if (error) throw error;
      return data;
    },
  });

  const { data: rows, isLoading } = useQuery({
    queryKey: ["admin-vpn"],
    queryFn: async () => {
      const [conns, statuses] = await Promise.all([
        supabase.from("vpn_connections").select("*, agents(nome)").order("nome"),
        supabase.from("vpn_status").select("*"),
      ]);
      if (conns.error) throw conns.error;
      const sMap = new Map((statuses.data ?? []).map((s) => [s.vpn_connection_id, s]));
      return (conns.data ?? []).map((c) => ({ ...c, status: sMap.get(c.id) }));
    },
    refetchInterval: 10_000,
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setOpen(true);
  };

  const openEdit = (row: any) => {
    setEditingId(row.id);
    setForm({
      nome: row.nome,
      protocol: row.protocol,
      agent_id: row.agent_id ?? "",
      endpoint_host: row.endpoint_host,
      endpoint_port: String(row.endpoint_port),
      grupo: row.grupo ?? "",
      observacoes: row.observacoes ?? "",
      wg_peer_public_key: row.wg_peer_public_key ?? "",
      wg_address_cidr: row.wg_address_cidr ?? "",
      wg_allowed_ips: row.wg_allowed_ips ?? "",
      wg_dns: row.wg_dns ?? "",
      wg_persistent_keepalive: String(row.wg_persistent_keepalive ?? 25),
      wg_private_key: "",
      wg_preshared_key: "",
      ovpn_config: "",
      ovpn_username: row.ovpn_username ?? "",
      ovpn_password: "",
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.nome.trim() || !form.endpoint_host.trim() || !form.agent_id) {
      toast.error("Nome, endpoint e agente são obrigatórios");
      return;
    }
    const port = parseInt(form.endpoint_port, 10);
    if (!port || port < 1 || port > 65535) {
      toast.error("Porta inválida");
      return;
    }
    setSaving(true);

    const base = {
      nome: form.nome.trim(),
      protocol: form.protocol,
      agent_id: form.agent_id,
      endpoint_host: form.endpoint_host.trim(),
      endpoint_port: port,
      grupo: form.grupo.trim() || null,
      observacoes: form.observacoes.trim() || null,
      ...(form.protocol === "wireguard"
        ? {
            wg_peer_public_key: form.wg_peer_public_key.trim() || null,
            wg_address_cidr: form.wg_address_cidr.trim() || null,
            wg_allowed_ips: form.wg_allowed_ips.trim() || null,
            wg_dns: form.wg_dns.trim() || null,
            wg_persistent_keepalive: parseInt(form.wg_persistent_keepalive, 10) || 25,
          }
        : {
            ovpn_username: form.ovpn_username.trim() || null,
          }),
    };

    let connectionId = editingId;
    if (editingId) {
      const { error } = await supabase.from("vpn_connections").update(base).eq("id", editingId);
      if (error) {
        setSaving(false);
        toast.error("Erro ao salvar", { description: error.message });
        return;
      }
    } else {
      const { data, error } = await supabase.from("vpn_connections").insert(base).select("id").single();
      if (error || !data) {
        setSaving(false);
        toast.error("Erro ao criar", { description: error?.message });
        return;
      }
      connectionId = data.id;
    }

    // gravar segredos só se preenchidos
    const setSecret = async (field: string, value: string) => {
      const { error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ error: { message: string } | null }>)("set_vpn_secret", {
        _connection_id: connectionId!,
        _field: field,
        _value: value,
      });
      return error;
    };

    const secretErrors: Array<{ message: string }> = [];
    if (form.protocol === "wireguard") {
      if (form.wg_private_key.trim()) {
        const e = await setSecret("wg_private_key", form.wg_private_key.trim());
        if (e) secretErrors.push(e);
      }
      if (form.wg_preshared_key.trim()) {
        const e = await setSecret("wg_preshared_key", form.wg_preshared_key.trim());
        if (e) secretErrors.push(e);
      }
    } else {
      if (form.ovpn_config.trim()) {
        const e = await setSecret("ovpn_config", form.ovpn_config);
        if (e) secretErrors.push(e);
      }
      if (form.ovpn_password.trim()) {
        const e = await setSecret("ovpn_password", form.ovpn_password);
        if (e) secretErrors.push(e);
      }
    }
    if (secretErrors.length > 0) {
      setSaving(false);
      toast.error("Erro ao salvar segredo", { description: secretErrors[0].message });
      return;
    }

    setSaving(false);
    toast.success(editingId ? "VPN atualizada" : "VPN criada");
    setOpen(false);
    qc.invalidateQueries({ queryKey: ["admin-vpn"] });
    qc.invalidateQueries({ queryKey: ["dashboard-vpn"] });
  };

  const toggleDesired = async (row: any) => {
    const next = row.desired_state === "up" ? "down" : "up";
    const { error } = await supabase.from("vpn_connections").update({ desired_state: next }).eq("id", row.id);
    if (error) toast.error("Erro", { description: error.message });
    else {
      toast.success(`Túnel marcado como ${next === "up" ? "ligado" : "desligado"}. Agente aplicará na próxima sync.`);
      qc.invalidateQueries({ queryKey: ["admin-vpn"] });
    }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    const { error } = await supabase.from("vpn_connections").delete().eq("id", deleteId);
    if (error) toast.error("Erro", { description: error.message });
    else {
      toast.success("VPN removida");
      qc.invalidateQueries({ queryKey: ["admin-vpn"] });
    }
    setDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Túneis WireGuard / OpenVPN. O agente Node faz polling a cada 15s e aplica os túneis.
        </p>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" /> Nova VPN
        </Button>
      </div>

      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Agente</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Latência</TableHead>
              <TableHead>Desejado</TableHead>
              <TableHead className="w-32 text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Carregando…</TableCell></TableRow>}
            {!isLoading && rows?.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">Nenhuma VPN cadastrada.</TableCell></TableRow>
            )}
            {rows?.map((r: any) => (
              <TableRow key={r.id}>
                <TableCell>
                  <div className="font-medium">{r.nome}</div>
                  {r.grupo && <div className="text-xs text-muted-foreground">{r.grupo}</div>}
                </TableCell>
                <TableCell><Badge variant="outline">{r.protocol === "wireguard" ? "WireGuard" : "OpenVPN"}</Badge></TableCell>
                <TableCell className="text-sm">{r.agents?.nome ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="font-mono text-xs">{r.endpoint_host}:{r.endpoint_port}</TableCell>
                <TableCell>
                  {r.status?.online ? (
                    <Badge variant="outline" className="border-status-online/40 text-status-online">Online</Badge>
                  ) : (
                    <Badge variant="outline" className="border-status-offline/40 text-status-offline">Offline</Badge>
                  )}
                  {r.status?.reported_at && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">{timeAgo(r.status.reported_at)}</div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">{r.status?.latency_ms != null ? `${r.status.latency_ms}ms` : "—"}</TableCell>
                <TableCell>
                  <Badge variant={r.desired_state === "up" ? "default" : "secondary"}>
                    {r.desired_state === "up" ? "↑ ligado" : "↓ desligado"}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" title="Histórico" onClick={() => setEventsFor({ id: r.id, nome: r.nome })}>
                    <History className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" title={r.desired_state === "up" ? "Desligar" : "Ligar"} onClick={() => toggleDesired(r)}>
                    {r.desired_state === "up" ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                  </Button>
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
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar VPN" : "Nova VPN"}</DialogTitle>
            <DialogDescription>
              Chaves privadas são criptografadas (pgsodium). Deixe em branco para manter a chave atual ao editar.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Nome *</Label>
                <Input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="vpn-poa-01" />
              </div>
              <div className="space-y-1">
                <Label>Grupo</Label>
                <Input value={form.grupo} onChange={(e) => setForm({ ...form, grupo: e.target.value })} placeholder="poa-mikrotiks" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Protocolo *</Label>
                <Select value={form.protocol} onValueChange={(v: Protocol) => setForm({ ...form, protocol: v, endpoint_port: v === "wireguard" ? "51820" : "1194" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wireguard">WireGuard</SelectItem>
                    <SelectItem value="openvpn">OpenVPN</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Agente *</Label>
                <Select value={form.agent_id} onValueChange={(v) => setForm({ ...form, agent_id: v })}>
                  <SelectTrigger><SelectValue placeholder="Selecionar agente" /></SelectTrigger>
                  <SelectContent>
                    {agents?.map((a) => (
                      <SelectItem key={a.id} value={a.id}>{a.nome}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <Label>Endpoint host *</Label>
                <Input value={form.endpoint_host} onChange={(e) => setForm({ ...form, endpoint_host: e.target.value })} placeholder="vpn.exemplo.com.br" />
              </div>
              <div className="space-y-1">
                <Label>Porta *</Label>
                <Input value={form.endpoint_port} onChange={(e) => setForm({ ...form, endpoint_port: e.target.value })} />
              </div>
            </div>

            {form.protocol === "wireguard" ? (
              <Tabs defaultValue="basic">
                <TabsList>
                  <TabsTrigger value="basic">Configuração</TabsTrigger>
                  <TabsTrigger value="keys">Chaves</TabsTrigger>
                </TabsList>
                <TabsContent value="basic" className="space-y-3 pt-3">
                  <div className="space-y-1">
                    <Label>Peer public key (do servidor remoto) *</Label>
                    <Input className="font-mono text-xs" value={form.wg_peer_public_key} onChange={(e) => setForm({ ...form, wg_peer_public_key: e.target.value })} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>Address (CIDR)</Label>
                      <Input value={form.wg_address_cidr} onChange={(e) => setForm({ ...form, wg_address_cidr: e.target.value })} placeholder="10.10.0.2/24" />
                    </div>
                    <div className="space-y-1">
                      <Label>Allowed IPs</Label>
                      <Input value={form.wg_allowed_ips} onChange={(e) => setForm({ ...form, wg_allowed_ips: e.target.value })} placeholder="10.10.0.0/24,192.168.88.0/24" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label>DNS</Label>
                      <Input value={form.wg_dns} onChange={(e) => setForm({ ...form, wg_dns: e.target.value })} placeholder="1.1.1.1" />
                    </div>
                    <div className="space-y-1">
                      <Label>Persistent keepalive (s)</Label>
                      <Input value={form.wg_persistent_keepalive} onChange={(e) => setForm({ ...form, wg_persistent_keepalive: e.target.value })} />
                    </div>
                  </div>
                </TabsContent>
                <TabsContent value="keys" className="space-y-3 pt-3">
                  <div className="space-y-1">
                    <Label>Private key (cliente) {editingId && <span className="text-xs text-muted-foreground">— deixe em branco para manter</span>}</Label>
                    <Input type="password" className="font-mono text-xs" value={form.wg_private_key} onChange={(e) => setForm({ ...form, wg_private_key: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>Preshared key (opcional)</Label>
                    <Input type="password" className="font-mono text-xs" value={form.wg_preshared_key} onChange={(e) => setForm({ ...form, wg_preshared_key: e.target.value })} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Gere o par de chaves no servidor: <code className="rounded bg-muted px-1">wg genkey | tee privkey | wg pubkey</code>
                  </p>
                </TabsContent>
              </Tabs>
            ) : (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label>Arquivo .ovpn {editingId && <span className="text-xs text-muted-foreground">— deixe em branco para manter</span>}</Label>
                  <Textarea rows={8} className="font-mono text-xs" value={form.ovpn_config} onChange={(e) => setForm({ ...form, ovpn_config: e.target.value })} placeholder="client&#10;dev tun&#10;proto udp&#10;remote vpn.exemplo.com 1194&#10;..." />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Usuário (auth-user-pass)</Label>
                    <Input value={form.ovpn_username} onChange={(e) => setForm({ ...form, ovpn_username: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label>Senha</Label>
                    <Input type="password" value={form.ovpn_password} onChange={(e) => setForm({ ...form, ovpn_password: e.target.value })} />
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <Label>Observações</Label>
              <Textarea rows={2} value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} />
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
            <AlertDialogTitle>Remover VPN?</AlertDialogTitle>
            <AlertDialogDescription>Status e histórico desta VPN serão apagados em cascata. Irreversível.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <VpnEventsDialog open={!!eventsFor} info={eventsFor} onClose={() => setEventsFor(null)} />
    </div>
  );
}

function VpnEventsDialog({ open, info, onClose }: { open: boolean; info: { id: string; nome: string } | null; onClose: () => void }) {
  const { data, refetch } = useQuery({
    queryKey: ["vpn-events", info?.id],
    enabled: !!info?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vpn_events")
        .select("*")
        .eq("vpn_connection_id", info!.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });
  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Histórico — {info?.nome}</DialogTitle>
          <DialogDescription>Últimos 100 eventos</DialogDescription>
        </DialogHeader>
        <div className="max-h-96 space-y-1 overflow-y-auto">
          {(data ?? []).length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">Sem eventos.</p>}
          {data?.map((e) => (
            <div key={e.id} className="flex items-start justify-between gap-3 rounded border border-border p-2 text-sm">
              <div>
                <Badge variant="outline" className="text-[10px]">{e.event_type}</Badge>
                {e.message && <span className="ml-2 text-muted-foreground">{e.message}</span>}
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">{timeAgo(e.created_at)}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
