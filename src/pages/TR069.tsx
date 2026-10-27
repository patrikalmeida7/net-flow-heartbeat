import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { RefreshCw, Wifi } from "lucide-react";

type Server = { id: string; nome: string; nbi_url: string; cwmp_url: string | null; username: string | null; enabled: boolean; last_check_at: string | null; last_error: string | null; organization_id: string | null; allow_insecure_http: boolean; sync_status: string; sync_cursor: number };
type Dev = { id: string; serial_number: string | null; manufacturer: string | null; model_name: string | null; software_version: string | null; pppoe_username: string | null; ip_address: string | null; wifi_ssid: string | null; wifi_ssid_5g: string | null; authorized: boolean; last_inform_at: string | null; params?: { wifi_source?: string } };
type Profile = { id: string; nome: string; manufacturer: string | null; product_class: string | null; model_name: string | null; firmware_prefix: string | null; data_model: string; wifi_2g_ssid_path: string | null; wifi_2g_password_path: string | null; wifi_5g_ssid_path: string | null; wifi_5g_password_path: string | null; allow_reboot: boolean; validated: boolean; organization_id: string; pilot_device_id: string | null };
type Task = { id: string; task_type: string; status: string; error: string | null; confirmation: string | null; payload: Record<string, unknown>; created_at: string };

const bridge = async (body: Record<string, unknown>) => {
  const { data, error } = await supabase.functions.invoke("tr069-bridge", { body });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(typeof data.error === "string" ? data.error : "Dados inválidos");
  return data;
};
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Bahia" }) : "—");
const informAge = (s: string | null) => {
  if (!s) return <Badge variant="outline">Nunca</Badge>;
  const min = (Date.now() - new Date(s).getTime()) / 60000;
  return min < 30 ? <Badge>Recente</Badge> : <Badge variant="secondary">{Math.round(min / 60)}h sem sessão</Badge>;
};

function ServerForm({ onDone, server }: { onDone: () => void; server?: Server }) {
  const [f, setF] = useState({ nome: server?.nome ?? "GenieACS", nbi_url: server?.nbi_url ?? "", cwmp_url: server?.cwmp_url ?? "", username: server?.username ?? "", password: "", allow_insecure_http: server?.allow_insecure_http ?? false });
  const save = async () => {
    const { data: org } = await supabase.from("organization_members").select("organization_id").limit(1).maybeSingle();
    if (!server?.organization_id && !org?.organization_id) return toast.error("Sua conta não pertence a nenhuma empresa");
    const row = { nome: f.nome, nbi_url: f.nbi_url.trim(), cwmp_url: f.cwmp_url.trim() || null, username: f.username.trim() || null, allow_insecure_http: f.allow_insecure_http, organization_id: server?.organization_id ?? org?.organization_id ?? null };
    const res = server ? await supabase.from("acs_servers").update(row).eq("id", server.id).select("id").single()
      : await supabase.from("acs_servers").insert(row).select("id").single();
    if (res.error) return toast.error(res.error.message);
    if (f.password) {
      try { await bridge({ action: "set_password", server_id: res.data.id, password: f.password }); }
      catch (e) { return toast.error((e as Error).message); }
    }
    toast.success("Servidor ACS salvo");
    onDone();
  };
  return (
    <div className="grid gap-3">
      {(["nome", "nbi_url", "cwmp_url", "username"] as const).map((k) => (
        <div key={k} className="grid gap-1">
          <Label>{{ nome: "Nome", nbi_url: "URL HTTPS da API NBI (ex.: https://acs.suaempresa.com.br)", cwmp_url: "URL CWMP para os modems (ex.: http://ip:7547)", username: "Usuário NBI (opcional)" }[k]}</Label>
          <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        </div>
      ))}
      <div className="grid gap-1"><Label>Senha NBI {server && "(deixe vazio para manter)"}</Label>
        <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={f.allow_insecure_http} onCheckedChange={(c) => setF({ ...f, allow_insecure_http: c })} />Exceção de laboratório: permitir HTTP sem criptografia (não use em produção)</label>
      <Button onClick={save} disabled={!f.nbi_url}>Salvar</Button>
    </div>
  );
}

function DeviceDialog({ dev, onClose, isAdmin }: { dev: Dev; onClose: () => void; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [band, setBand] = useState<"2g" | "5g">("2g");
  const [ssid, setSsid] = useState("");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [reqId, setReqId] = useState(() => crypto.randomUUID());
  const tasks = useQuery({
    queryKey: ["tr069_tasks", dev.id],
    queryFn: async () => {
      await bridge({ action: "task_status", device_id: dev.id }).catch(() => null);
      const { data, error } = await supabase.from("tr069_tasks").select("*").eq("device_id", dev.id).order("created_at", { ascending: false }).limit(20);
      if (error) throw error;
      return data as Task[];
    },
    refetchInterval: 30000,
  });
  const send = async () => {
    setBusy(true);
    try {
      const r = await bridge({ action: "set_wifi", device_id: dev.id, request_id: reqId, band, ssid: ssid || undefined, password: pwd || undefined });
      if (r.status === "completed") toast.success("Aplicado no equipamento");
      else toast.info(r.message ?? "Comando pendente até a próxima sessão do equipamento");
      setPwd(""); setReqId(crypto.randomUUID());
      qc.invalidateQueries({ queryKey: ["tr069_tasks", dev.id] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const statusLabel: Record<string, string> = { requested: "Solicitada", unknown: "Resultado desconhecido", pending: "Solicitada", queued: "Pendente (próxima sessão)", completed: "Concluída (confirmada)", unconfirmed: "Aplicada sem confirmação", failed: "Falhou" };
  const resolve = async (task_id: string, outcome: "failed" | "unconfirmed") => {
    if (!window.confirm("Confirme que você conferiu no ACS o que aconteceu com esta tarefa.")) return;
    try { await bridge({ action: "resolve_unknown", device_id: dev.id, task_id, outcome }); qc.invalidateQueries({ queryKey: ["tr069_tasks", dev.id] }); }
    catch (e) { toast.error((e as Error).message); }
  };
  const reboot = async () => {
    if (!window.confirm("Reiniciar este equipamento? O cliente ficará sem internet por alguns minutos.")) return;
    setBusy(true);
    try { const r = await bridge({ action: "reboot", device_id: dev.id, request_id: crypto.randomUUID(), confirm: true }); toast.info(r.message ?? r.status); qc.invalidateQueries({ queryKey: ["tr069_tasks", dev.id] }); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{dev.manufacturer} {dev.model_name} · {dev.serial_number}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>Firmware: {dev.software_version ?? "—"}</div><div>Último Inform: {fmt(dev.last_inform_at)}</div>
          <div className="col-span-2 font-mono text-xs text-muted-foreground">ID: {dev.id}</div>
          <div>PPPoE: {dev.pppoe_username ?? "—"}</div><div>IP WAN: {dev.ip_address ?? "—"}</div>
          <div>Wi-Fi 2.4G: {dev.wifi_ssid ?? "—"}</div><div>Wi-Fi 5G: {dev.wifi_ssid_5g ?? "—"}</div>
        </div>
        {isAdmin && (dev.authorized ? (
          <Card><CardHeader><CardTitle className="text-base">Alterar Wi-Fi</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex gap-2">
                <Button size="sm" variant={band === "2g" ? "default" : "outline"} onClick={() => setBand("2g")}>2.4 GHz</Button>
                <Button size="sm" variant={band === "5g" ? "default" : "outline"} onClick={() => setBand("5g")}>5 GHz</Button>
              </div>
              <Input placeholder="Novo nome (SSID) — opcional" maxLength={32} value={ssid} onChange={(e) => setSsid(e.target.value)} />
              <Input placeholder="Nova senha (8–63) — opcional" type="password" value={pwd} onChange={(e) => setPwd(e.target.value)} />
              <p className="text-xs text-muted-foreground">Se o ACS não alcançar o equipamento, o comando fica pendente e é aplicado na próxima sessão iniciada pelo modem. Só funciona com perfil validado para este modelo/firmware; bandas sem parâmetro no perfil são recusadas. A senha não pode ser conferida por leitura.</p>
              <div className="flex gap-2"><Button onClick={send} disabled={busy || (!ssid && pwd.length < 8)}>Enviar</Button>
                <Button variant="outline" onClick={reboot} disabled={busy}>Reiniciar…</Button></div>
            </CardContent></Card>
        ) : <p className="text-sm text-muted-foreground">Autorize o equipamento para liberar comandos.</p>)}
        <div>
          <h4 className="mb-2 text-sm font-medium">Tarefas</h4>
          {tasks.isError && <p className="text-sm text-destructive">Erro ao carregar tarefas.</p>}
          {tasks.data?.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma tarefa.</p>}
          {tasks.data?.map((t) => (
            <div key={t.id} className="flex justify-between border-b py-1 text-sm">
              <span>{fmt(t.created_at)} · {t.task_type === "reboot" ? "Reinício" : `Wi-Fi ${String(t.payload.band ?? "")}`}{t.payload.ssid ? ` → ${t.payload.ssid}` : ""}{t.payload.password_changed ? " · senha" : ""}</span>
              <span title={t.error ?? t.confirmation ?? ""}><Badge variant={t.status === "failed" ? "destructive" : "outline"}>{statusLabel[t.status] ?? t.status}</Badge>
                {isAdmin && t.status === "unknown" && <><Button size="sm" variant="link" onClick={() => resolve(t.id, "failed")}>Não executou</Button><Button size="sm" variant="link" onClick={() => resolve(t.id, "unconfirmed")}>Executou</Button></>}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function TR069() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Server | "new" | null>(null);
  const [open, setOpen] = useState<Dev | null>(null);
  const [busy, setBusy] = useState(false);

  const servers = useQuery({ queryKey: ["acs_servers"], queryFn: async () => {
    const { data, error } = await supabase.from("acs_servers").select("id,nome,nbi_url,cwmp_url,username,enabled,last_check_at,last_error,organization_id,allow_insecure_http,sync_status,sync_cursor").order("created_at");
    if (error) throw error; return data as Server[];
  } });
  const devices = useQuery({ queryKey: ["tr069_devices", search], queryFn: async () => {
    let q = supabase.from("tr069_devices").select("*", { count: "exact" }).order("last_inform_at", { ascending: false, nullsFirst: false }).limit(200);
    const s = search.trim().replace(/[%,()]/g, "");
    if (s) q = q.or(`serial_number.ilike.%${s}%,pppoe_username.ilike.%${s}%,model_name.ilike.%${s}%,wifi_ssid.ilike.%${s}%`);
    const { data, error, count } = await q;
    if (error) throw error; return { rows: data as Dev[], count: count ?? 0 };
  } });

  const run = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      const r = await bridge(body);
      if (r.complete === false && r.ok !== false) toast.info(`Sincronização parcial: ${r.synced} lidos nesta etapa. Clique em Sincronizar para continuar.`);
      else if (r.ok === false) toast.error(r.error ?? "Falhou"); else toast.success(r.synced != null ? `${ok}: ${r.synced} equipamentos` : ok);
      qc.invalidateQueries({ queryKey: ["acs_servers"] }); qc.invalidateQueries({ queryKey: ["tr069_devices"] });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const toggleAuth = async (d: Dev) => {
    try { await bridge({ action: "approve", device_id: d.id, authorized: !d.authorized }); qc.invalidateQueries({ queryKey: ["tr069_devices"] }); }
    catch (e) { toast.error((e as Error).message); }
  };

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Modems / ONTs (TR-069)</h1>
        <p className="text-sm text-muted-foreground">Gerenciamento via GenieACS. Independente do monitoramento SNMP e da VPN.</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">Servidores ACS</CardTitle>
          {isAdmin && <Button size="sm" onClick={() => setEditing("new")}>Adicionar</Button>}</CardHeader>
        <CardContent className="space-y-2">
          {servers.isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
          {servers.isError && <p className="text-sm text-destructive">Erro ao carregar servidores: {(servers.error as Error)?.message ?? "desconhecido"}. <Button variant="link" onClick={() => servers.refetch()}>Tentar novamente</Button></p>}
          {servers.data?.length === 0 && <p className="text-sm text-muted-foreground">Nenhum ACS cadastrado. Instale o GenieACS na VPS (pasta deploy/genieacs) e cadastre aqui.</p>}
          {servers.data?.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b pb-2 text-sm">
              <div><b>{s.nome}</b> · {s.nbi_url}{s.cwmp_url && <> · modems: {s.cwmp_url}</>}<br />
                <span className="text-muted-foreground">{s.sync_status === "partial" && <Badge variant="secondary" className="mr-1">Sincronização parcial (continua de {s.sync_cursor})</Badge>}{s.allow_insecure_http && <Badge variant="destructive" className="mr-1">HTTP laboratório</Badge>}Último teste: {fmt(s.last_check_at)} {s.last_error && <span className="text-destructive">· {s.last_error}</span>}</span></div>
              {isAdmin && <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ action: "test", server_id: s.id }, "Conexão OK")}>Testar</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ action: "sync", server_id: s.id }, "Sincronizado")}><RefreshCw className="mr-1 h-3 w-3" />Sincronizar</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>Editar</Button>
              </div>}
            </div>
          ))}
        </CardContent>
      </Card>

      <ProfilesCard isAdmin={isAdmin} />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Equipamentos {devices.data && `(${devices.data.count})`}</CardTitle>
          <Input className="max-w-xs" placeholder="Serial, PPPoE, modelo, SSID" value={search} onChange={(e) => setSearch(e.target.value)} />
        </CardHeader>
        <CardContent>
          {devices.isError && <p className="text-sm text-destructive">Erro ao carregar. <Button variant="link" onClick={() => devices.refetch()}>Tentar novamente</Button></p>}
          <Table>
            <TableHeader><TableRow><TableHead>Serial</TableHead><TableHead>Modelo</TableHead><TableHead>PPPoE</TableHead><TableHead>Wi-Fi</TableHead><TableHead>Sessão</TableHead><TableHead>Aprovado</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {devices.isLoading && <TableRow><TableCell colSpan={7}>Carregando…</TableCell></TableRow>}
              {devices.data?.rows.length === 0 && <TableRow><TableCell colSpan={7} className="text-muted-foreground">Nenhum equipamento sincronizado.</TableCell></TableRow>}
              {devices.data?.rows.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs">{d.serial_number ?? "—"}</TableCell>
                  <TableCell>{d.manufacturer} {d.model_name}</TableCell>
                  <TableCell>{d.pppoe_username ?? "—"}</TableCell>
                  <TableCell>{d.wifi_ssid ?? "—"}{d.params?.wifi_source !== "profile" && d.wifi_ssid && <span className="ml-1 text-xs text-muted-foreground" title="Lido por caminho padrão ou perfil não validado">(não validado)</span>}</TableCell>
                  <TableCell>{informAge(d.last_inform_at)}</TableCell>
                  <TableCell><Switch checked={d.authorized} disabled={!isAdmin} onCheckedChange={() => toggleAuth(d)} /></TableCell>
                  <TableCell className="flex gap-1">
                    {isAdmin && <Button size="icon" variant="ghost" title="Atualizar do ACS" onClick={() => run({ action: "refresh", device_id: d.id }, "Atualizado")}><RefreshCw className="h-4 w-4" /></Button>}
                    <Button size="icon" variant="ghost" title="Detalhes / Wi-Fi" onClick={() => setOpen(d)}><Wifi className="h-4 w-4" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent><DialogHeader><DialogTitle>Servidor ACS</DialogTitle></DialogHeader>
          {editing && <ServerForm server={editing === "new" ? undefined : editing} onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["acs_servers"] }); }} />}
        </DialogContent>
      </Dialog>
      {open && <DeviceDialog dev={open} isAdmin={isAdmin} onClose={() => setOpen(null)} />}
    </div>
  );
}

const PF = [["nome","Nome"],["manufacturer","Fabricante (igual ao ACS)"],["product_class","Product class"],["model_name","Modelo"],["firmware_prefix","Firmware começa com"],["wifi_2g_ssid_path","Parâmetro SSID 2,4 GHz"],["wifi_2g_password_path","Parâmetro senha 2,4 GHz"],["wifi_5g_ssid_path","Parâmetro SSID 5 GHz (vazio = sem suporte)"],["wifi_5g_password_path","Parâmetro senha 5 GHz"],["pilot_device_id","Equipamento piloto (ID) — libera só ele enquanto não validado"]] as const;
function ProfilesCard({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Partial<Profile> | null>(null);
  const list = useQuery({ queryKey: ["tr069_profiles"], queryFn: async () => {
    const { data, error } = await supabase.from("tr069_profiles").select("*").order("nome"); if (error) throw error; return data as Profile[];
  } });
  const save = async () => {
    if (!edit) return;
    const { data: org } = await supabase.from("organization_members").select("organization_id").limit(1).maybeSingle();
    const row = { ...Object.fromEntries(PF.map(([k]) => [k, (edit[k] as string | null)?.trim() || null])), nome: edit.nome?.trim() || "Perfil",
      allow_reboot: !!edit.allow_reboot, validated: !!edit.validated, organization_id: edit.organization_id ?? org?.organization_id } as Record<string, unknown>;
    if (!row.organization_id) return toast.error("Sua conta não pertence a nenhuma empresa");
    if (!row.manufacturer && !row.product_class && !row.model_name) return toast.error("Informe fabricante, product class ou modelo");
    const res = edit.id ? await supabase.from("tr069_profiles").update(row as never).eq("id", edit.id) : await supabase.from("tr069_profiles").insert(row as never);
    if (res.error) return toast.error(res.error.message);
    setEdit(null); qc.invalidateQueries({ queryKey: ["tr069_profiles"] });
  };
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">Perfis de modelo/firmware</CardTitle>
        {isAdmin && <Button size="sm" onClick={() => setEdit({})}>Adicionar</Button>}</CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p className="text-xs text-muted-foreground">Comandos só são liberados para equipamentos aprovados cujo modelo/firmware tenha um perfil marcado como validado (testado em um equipamento real).</p>
        {list.isError && <p className="text-destructive">Erro ao carregar perfis.</p>}
        {list.data?.length === 0 && <p className="text-muted-foreground">Nenhum perfil: todos os comandos estão bloqueados.</p>}
        {list.data?.map((p) => (
          <div key={p.id} className="flex items-center justify-between border-b py-1">
            <span><b>{p.nome}</b> · {[p.manufacturer, p.product_class, p.model_name, p.firmware_prefix && `fw ${p.firmware_prefix}*`].filter(Boolean).join(" · ")} · {p.wifi_5g_ssid_path ? "2,4+5 GHz" : "2,4 GHz"}{p.allow_reboot && " · reinício"}</span>
            <span className="flex gap-2"><Badge variant={p.validated ? "default" : "secondary"}>{p.validated ? "Validado" : "Não validado"}</Badge>
              {isAdmin && <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Editar</Button>}</span>
          </div>
        ))}
      </CardContent>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Perfil de parâmetros</DialogTitle></DialogHeader>
          {edit && <div className="grid gap-2">
            {PF.map(([k, l]) => <div key={k} className="grid gap-1"><Label>{l}</Label>
              <Input value={(edit[k] as string) ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /></div>)}
            <label className="flex items-center gap-2 text-sm"><Switch checked={!!edit.allow_reboot} onCheckedChange={(c) => setEdit({ ...edit, allow_reboot: c })} />Permitir reinício</label>
            <label className="flex items-center gap-2 text-sm"><Switch checked={!!edit.validated} onCheckedChange={(c) => setEdit({ ...edit, validated: c })} />Validado em equipamento real</label>
            <Button onClick={save}>Salvar</Button>
          </div>}
        </DialogContent>
      </Dialog>
    </Card>
  );
}
