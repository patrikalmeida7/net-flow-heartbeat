import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Save, X, RotateCcw, Star, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { DashPanel, type Device } from "@/components/dashboard/DashPanel";
import { PanelEditor } from "@/components/dashboard/PanelEditor";
import { PERIODS, defaultPanels, kindsFor, needsInterface, type Panel } from "@/lib/dashboardLogic";
import type { Json } from "@/integrations/supabase/types";

type Dash = { id: string; nome: string; is_default: boolean; panels: Panel[] };
const W = { 1: "md:col-span-1", 2: "md:col-span-2", 3: "md:col-span-3", 4: "md:col-span-4" } as const;

export default function DashboardsPersonalizadas() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [selId, setSelId] = useState<string | null>(null);
  const [period, setPeriod] = useState<keyof typeof PERIODS | "custom">("6h");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [refresh, setRefresh] = useState<number>(60);
  const [globalDev, setGlobalDev] = useState<string>("");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Panel[]>([]);
  const [editing, setEditing] = useState<Panel | null>(null);
  const [zoom, setZoom] = useState<Panel | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const dashQ = useQuery({
    queryKey: ["custom_dashboards"],
    queryFn: async () => {
      const { data, error } = await supabase.from("custom_dashboards").select("id,nome,is_default,panels").order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as Dash[];
    },
  });
  const devQ = useQuery({
    queryKey: ["dash-devices"],
    queryFn: async () => {
      const [c, r, i] = await Promise.all([
        supabase.from("concentradores").select("id,nome,snmp_status,snmp_last_success_at").order("nome"),
        supabase.from("rbs").select("id,nome,snmp_status,snmp_last_success_at").order("nome"),
        supabase.from("device_interfaces").select("id,concentrador_id,rbs_id,if_index,if_name,if_alias").eq("counter_source", "snmp").order("if_index"),
      ]);
      if (c.error) throw c.error;
      const devices: Device[] = [...(c.data ?? []).map((x) => ({ ...x, type: "conc" as const })), ...(r.data ?? []).map((x) => ({ ...x, type: "rbs" as const }))];
      const ifaces = (i.data ?? []).map((x) => ({ id: x.id, device: (x.concentrador_id ?? x.rbs_id)!, label: `${x.if_name ?? "if" + x.if_index}${x.if_alias ? " · " + x.if_alias : ""}` }));
      return { devices, ifaces };
    },
    refetchInterval: 60_000,
  });
  const devices = devQ.data?.devices ?? [];
  const ifaces = devQ.data?.ifaces ?? [];

  const dashes = dashQ.data ?? [];
  const current = dashes.find((d) => d.id === selId) ?? dashes.find((d) => d.is_default) ?? dashes[0];
  useEffect(() => { if (current && !edit) setDraft(current.panels ?? []); }, [current, edit]);
  useEffect(() => { if (!globalDev && devices[0]) setGlobalDev(devices[0].id); }, [devices, globalDev]);
  useEffect(() => { if (!refresh) return; const t = setInterval(() => setTick((x) => x + 1), refresh * 1000); return () => clearInterval(t); }, [refresh]);

  const range = useMemo(() => {
    if (period === "custom" && custom.from && custom.to) return { since: new Date(custom.from).toISOString(), until: new Date(custom.to).toISOString() };
    const now = Math.floor(Date.now() / 30000) * 30000; // estabiliza chave para compartilhar consultas
    return { since: new Date(now - PERIODS[period === "custom" ? "6h" : period] * 1000).toISOString(), until: new Date(now + 30000).toISOString() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, custom, tick]);

  const panels = edit ? draft : current?.panels ?? [];
  const devOf = (p: Panel) => p.concentrador_id ?? p.rbs_id ?? globalDev ?? null;
  const usedDevs = [...new Set(panels.map(devOf).filter(Boolean))] as string[];
  const catQ = useQuery({
    queryKey: ["dash-catalog", usedDevs.join(","), tick],
    enabled: usedDevs.length > 0,
    queryFn: async () => {
      const out = new Map<string, Map<string, string>>();
      for (const id of usedDevs) {
        const d = devices.find((x) => x.id === id);
        const { data, error } = await supabase.rpc("metric_catalog", { _concentrador: d?.type === "conc" ? id : null, _rbs: d?.type === "rbs" ? id : null });
        if (error) throw error;
        out.set(id, new Map((data ?? []).map((r) => [`${r.kind}|${r.interface_id ?? ""}`, r.last_at as string])));
      }
      return out;
    },
  });
  const supportedAt = (p: Panel) => {
    const m = catQ.data?.get(devOf(p) ?? "");
    if (!m) return undefined;
    const k = kindsFor(p.metric)[0];
    return k ? m.get(`${k}|${needsInterface(p.metric) ? p.interface_id ?? "" : ""}`) : undefined;
  };
  const catalogKinds = new Set([...(catQ.data?.get(globalDev)?.keys() ?? [])].map((k) => k.split("|")[0]));
  const refetchMs = refresh ? refresh * 1000 : false;

  async function save() {
    if (!current) return;
    const { error } = await supabase.from("custom_dashboards").update({ panels: draft as unknown as Json }).eq("id", current.id);
    if (error) return toast.error(error.message);
    toast.success("Dashboard salva"); setEdit(false); qc.invalidateQueries({ queryKey: ["custom_dashboards"] });
  }
  async function create() {
    const nome = prompt("Nome da dashboard", "Nova dashboard")?.trim();
    if (!nome) return;
    const firstIface = ifaces.find((i) => i.device === globalDev)?.id ?? null;
    const dev = devices.find((d) => d.id === globalDev);
    const { data, error } = await supabase.from("custom_dashboards").insert({ nome: nome.slice(0, 60), is_default: dashes.length === 0, panels: defaultPanels(dev?.type === "conc" ? globalDev : null, firstIface) as unknown as Json }).select("id").single();
    if (error) return toast.error(error.message);
    setSelId(data.id); qc.invalidateQueries({ queryKey: ["custom_dashboards"] });
  }
  async function makeDefault() {
    if (!current) return;
    await supabase.from("custom_dashboards").update({ is_default: false }).neq("id", current.id);
    const { error } = await supabase.from("custom_dashboards").update({ is_default: true }).eq("id", current.id);
    if (error) toast.error(error.message); else { toast.success("Definida como padrão"); qc.invalidateQueries({ queryKey: ["custom_dashboards"] }); }
  }
  async function remove() {
    if (!current || !confirm(`Excluir "${current.nome}"?`)) return;
    const { error } = await supabase.from("custom_dashboards").delete().eq("id", current.id);
    if (error) toast.error(error.message); else { setSelId(null); qc.invalidateQueries({ queryKey: ["custom_dashboards"] }); }
  }
  const addPanel = () => { const p: Panel = { id: crypto.randomUUID(), title: "Novo painel", viz: "line", metric: "cpu_load", w: 2, h: 1, decimals: 1, legend: true }; setDraft([...draft, p]); setEditing(p); };
  const portGrid = () => {
    const ps = ifaces.filter((i) => i.device === globalDev).slice(0, 8).map((i): Panel => ({ id: crypto.randomUUID(), title: i.label, viz: "area", metric: "if_traffic", concentrador_id: devices.find((d) => d.id === globalDev)?.type === "conc" ? globalDev : null, rbs_id: devices.find((d) => d.id === globalDev)?.type === "rbs" ? globalDev : null, interface_id: i.id, w: 2, h: 1, decimals: 1, legend: false }));
    setDraft([...draft, ...ps]);
  };
  const onDrop = (target: string) => {
    if (!dragId || dragId === target) return;
    const a = [...draft], from = a.findIndex((x) => x.id === dragId), to = a.findIndex((x) => x.id === target);
    const [m] = a.splice(from, 1); a.splice(to, 0, m); setDraft(a); setDragId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Dashboards SNMP</h1>
          <p className="text-xs text-muted-foreground">Somente métricas SNMP observadas. A tela atualiza sozinha; a coleta do agente não muda.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dashes.length > 0 && (
            <Select value={current?.id} onValueChange={(v) => { setSelId(v); setEdit(false); }}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>{dashes.map((d) => <SelectItem key={d.id} value={d.id}>{d.is_default ? "★ " : ""}{d.nome}</SelectItem>)}</SelectContent>
            </Select>
          )}
          {isAdmin && !edit && <>
            <Button size="sm" variant="outline" onClick={create}><Plus className="mr-1 h-4 w-4" />Nova</Button>
            {current && <Button size="sm" onClick={() => { setDraft(current.panels ?? []); setEdit(true); }}><Pencil className="mr-1 h-4 w-4" />Editar dashboard</Button>}
          </>}
        </div>
      </div>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <Select value={globalDev} onValueChange={setGlobalDev}>
          <SelectTrigger className="w-52"><SelectValue placeholder="Equipamento" /></SelectTrigger>
          <SelectContent>{devices.map((d) => <SelectItem key={d.id} value={d.id}>{d.nome}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={period} onValueChange={(v) => setPeriod(v as typeof period)}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1h">Última hora</SelectItem><SelectItem value="6h">6 horas</SelectItem>
            <SelectItem value="24h">24 horas</SelectItem><SelectItem value="7d">7 dias</SelectItem><SelectItem value="custom">Personalizado</SelectItem>
          </SelectContent>
        </Select>
        {period === "custom" && <>
          <Input type="datetime-local" className="w-48" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          <Input type="datetime-local" className="w-48" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
        </>}
        <Select value={String(refresh)} onValueChange={(v) => setRefresh(Number(v))}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="0">Sem atualização</SelectItem><SelectItem value="30">Tela a cada 30s</SelectItem><SelectItem value="60">Tela a cada 1 min</SelectItem><SelectItem value="300">Tela a cada 5 min</SelectItem></SelectContent>
        </Select>
        {edit && <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={addPanel}><Plus className="mr-1 h-4 w-4" />Painel</Button>
          <Button size="sm" variant="outline" onClick={portGrid}>+ Grade de portas</Button>
          <Button size="sm" variant="outline" onClick={() => setDraft(defaultPanels(devices.find((d) => d.id === globalDev)?.type === "conc" ? globalDev : null, ifaces.find((i) => i.device === globalDev)?.id ?? null))}><RotateCcw className="mr-1 h-4 w-4" />Padrão</Button>
          <Button size="sm" variant="outline" onClick={makeDefault}><Star className="mr-1 h-4 w-4" />Definir padrão</Button>
          <Button size="sm" variant="outline" onClick={remove}><Trash2 className="mr-1 h-4 w-4" />Excluir</Button>
          <Button size="sm" variant="outline" onClick={() => setEdit(false)}><X className="mr-1 h-4 w-4" />Cancelar</Button>
          <Button size="sm" onClick={save}><Save className="mr-1 h-4 w-4" />Salvar</Button>
        </div>}
      </Card>

      {dashQ.isLoading && <p className="text-sm text-muted-foreground">Carregando…</p>}
      {dashQ.error && <p className="text-sm text-destructive">Erro ao carregar dashboards. <Button size="sm" variant="outline" onClick={() => dashQ.refetch()}>Tentar de novo</Button></p>}
      {!dashQ.isLoading && dashes.length === 0 && <Card className="p-6 text-center text-sm text-muted-foreground">Nenhuma dashboard ainda. {isAdmin ? "Clique em “Nova” para criar com o modelo pronto." : "Peça a um administrador para criar."}</Card>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        {panels.map((p) => (
          <div key={p.id} className={`${W[p.w]} ${edit && dragId === p.id ? "opacity-50" : ""}`}
            draggable={edit} onDragStart={() => setDragId(p.id)} onDragOver={(e) => edit && e.preventDefault()} onDrop={() => onDrop(p.id)}>
            <DashPanel p={p} deviceId={devOf(p)} device={devices.find((d) => d.id === devOf(p))} range={range} refreshMs={refetchMs}
              supportedAt={supportedAt(p)} catalogError={!!catQ.error} edit={edit}
              onEdit={() => setEditing(p)} onDup={() => setDraft([...draft, { ...p, id: crypto.randomUUID(), title: p.title + " (cópia)" }])}
              onDel={() => setDraft(draft.filter((x) => x.id !== p.id))} onZoom={() => setZoom(p)} />
          </div>
        ))}
      </div>

      <PanelEditor panel={editing} devices={devices} ifaces={ifaces} catalog={catalogKinds}
        onClose={() => setEditing(null)} onSave={(np) => { setDraft(draft.map((x) => (x.id === np.id ? np : x))); setEditing(null); }} />
      <Dialog open={!!zoom} onOpenChange={(o) => !o && setZoom(null)}>
        <DialogContent className="max-w-5xl">
          <DialogHeader><DialogTitle>{zoom?.title}</DialogTitle></DialogHeader>
          {zoom && <DashPanel p={{ ...zoom, h: 2 }} zoom deviceId={devOf(zoom)} device={devices.find((d) => d.id === devOf(zoom))} range={range} refreshMs={refetchMs} supportedAt={supportedAt(zoom)} catalogError={!!catQ.error} edit={false} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
