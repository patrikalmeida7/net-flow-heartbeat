import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { needsInterface, type Panel, type MetricKind, type Viz } from "@/lib/dashboardLogic";
import type { Device } from "./DashPanel";

export const METRICS: { v: MetricKind; l: string }[] = [
  { v: "cpu_load", l: "CPU (%)" }, { v: "memory_used_pct", l: "Memória (%)" }, { v: "uptime_seconds", l: "Uptime (duração)" },
  { v: "temperature_c", l: "Temperatura (°C)" }, { v: "if_traffic", l: "Interface RX/TX (bps)" }, { v: "if_oper_status", l: "Estado da interface" },
  { v: "if_errors", l: "Erros da interface" }, { v: "collect_health", l: "Saúde da coleta SNMP" }, { v: "clients", l: "Clientes conectados" },
];
const VIZ: { v: Viz; l: string }[] = [{ v: "number", l: "Número" }, { v: "gauge", l: "Indicador semicircular" }, { v: "state", l: "Estado" }, { v: "line", l: "Linha" }, { v: "area", l: "Área" }];

export function PanelEditor({ panel, devices, ifaces, catalog, onSave, onClose }: {
  panel: Panel | null; devices: Device[]; ifaces: { id: string; label: string; device: string }[];
  catalog: Set<string>; onSave: (p: Panel) => void; onClose: () => void;
}) {
  const [p, setP] = useState<Panel | null>(panel);
  useEffect(() => setP(panel), [panel]);
  if (!p) return null;
  const dev = p.concentrador_id ?? p.rbs_id ?? "";
  const set = (patch: Partial<Panel>) => setP({ ...p, ...patch });
  const devIfaces = ifaces.filter((i) => i.device === dev);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Configurar painel</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div><Label>Título</Label><Input value={p.title} maxLength={60} onChange={(e) => set({ title: e.target.value })} /></div>
          <div><Label>Equipamento</Label>
            <Select value={dev || "_global"} onValueChange={(v) => {
              const d = devices.find((x) => x.id === v);
              set({ concentrador_id: d?.type === "conc" ? v : null, rbs_id: d?.type === "rbs" ? v : null, interface_id: null });
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="_global">Usar filtro da tela</SelectItem>
                {devices.map((d) => <SelectItem key={d.id} value={d.id}>{d.nome}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div><Label>Métrica</Label>
            <Select value={p.metric} onValueChange={(v) => set({ metric: v as MetricKind })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{METRICS.map((m) => <SelectItem key={m.v} value={m.v}>{m.l}{catalog.size && !needsInterface(m.v) && !["collect_health", "clients"].includes(m.v) && !catalog.has(m.v) ? " — não observada" : ""}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {needsInterface(p.metric) && (
            <div><Label>Interface</Label>
              <Select value={p.interface_id ?? ""} onValueChange={(v) => set({ interface_id: v })}>
                <SelectTrigger><SelectValue placeholder={dev ? "Escolha" : "Defina o equipamento do painel"} /></SelectTrigger>
                <SelectContent>{devIfaces.map((i) => <SelectItem key={i.id} value={i.id}>{i.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Visualização</Label>
              <Select value={p.viz} onValueChange={(v) => set({ viz: v as Viz })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{VIZ.map((m) => <SelectItem key={m.v} value={m.v}>{m.l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Cor</Label><Input type="color" value={p.color || "#22c55e"} onChange={(e) => set({ color: e.target.value })} /></div>
            <div><Label>Largura</Label>
              <Select value={String(p.w)} onValueChange={(v) => set({ w: Number(v) as Panel["w"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{[1, 2, 3, 4].map((n) => <SelectItem key={n} value={String(n)}>{n}/4</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Altura</Label>
              <Select value={String(p.h)} onValueChange={(v) => set({ h: Number(v) as Panel["h"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="1">Baixa</SelectItem><SelectItem value="2">Alta</SelectItem></SelectContent>
              </Select>
            </div>
            <div><Label>Casas decimais</Label><Input type="number" min={0} max={4} value={p.decimals ?? 1} onChange={(e) => set({ decimals: Math.max(0, Math.min(4, Number(e.target.value) || 0)) })} /></div>
            <div><Label>Unidade (custom)</Label><Input value={p.unit ?? ""} maxLength={10} onChange={(e) => set({ unit: e.target.value })} /></div>
            <div><Label>Limite atenção</Label><Input type="number" value={p.warn ?? ""} onChange={(e) => set({ warn: e.target.value === "" ? null : Number(e.target.value) })} /></div>
            <div><Label>Limite crítico</Label><Input type="number" value={p.crit ?? ""} onChange={(e) => set({ crit: e.target.value === "" ? null : Number(e.target.value) })} /></div>
          </div>
          <div className="flex items-center gap-2"><Switch checked={!!p.legend} onCheckedChange={(v) => set({ legend: v })} /><Label>Mostrar legenda</Label></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onSave(p)}>Aplicar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
