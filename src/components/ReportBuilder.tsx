import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Pencil, Trash2, Send, Eye, Clock, CalendarClock, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import { toast } from "sonner";

type Rep = {
  id?: string; nome: string; enabled: boolean; trigger_type: "interval" | "fixed" | "condition";
  interval_minutes: number; fixed_times: string[]; days: number[]; condition_key: string | null;
  condition_threshold: number; condition_window_minutes: number; cooldown_minutes: number;
  concentrador_id: string | null; phones: string[]; template: string;
  last_sent_at?: string | null; last_success?: boolean | null; last_error?: string | null;
};

const blank: Rep = {
  nome: "", enabled: true, trigger_type: "interval", interval_minutes: 60, fixed_times: ["08:00"], days: [0, 1, 2, 3, 4, 5, 6],
  condition_key: "mass_disconnect", condition_threshold: 10, condition_window_minutes: 5, cooldown_minutes: 30,
  concentrador_id: null, phones: [], template: "🔔 *{saudacao}! {nome_relatorio}*\n📅 {data} às {hora}\n\n👥 Online: *{online_total}*\n📉 Quedas: *{quedas_periodo}*",
};

const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const INTERVALS = [[1, "1 min"], [5, "5 min"], [10, "10 min"], [15, "15 min"], [30, "30 min"], [60, "1 hora"], [120, "2 horas"], [180, "3 horas"], [360, "6 horas"], [720, "12 horas"], [1440, "1 dia"]] as const;
const CONDITIONS: Record<string, { label: string; thr: string }> = {
  mass_disconnect: { label: "Queda em massa", thr: "Nº de clientes que caíram" },
  concentrador_down: { label: "Concentrador offline", thr: "—" },
  cpu_high: { label: "CPU alta", thr: "CPU acima de (%)" },
  memory_high: { label: "Memória alta", thr: "Memória acima de (%)" },
  online_below: { label: "Clientes online abaixo de", thr: "Mínimo de clientes online" },
  client_unstable: { label: "Clientes instáveis", thr: "Quedas em 24h por cliente" },
};
const COOLDOWNS = [[0, "Sempre"], [5, "5 min"], [15, "15 min"], [30, "30 min"], [60, "1 hora"], [180, "3 horas"], [360, "6 horas"], [1440, "1 dia"]] as const;

const VARS: [string, string[]][] = [
  ["Clientes", ["online_total", "quedas_periodo", "quedas_24h", "clientes_instaveis", "top_quedas", "top_consumidor_nome", "top_consumidor_gb"]],
  ["Concentrador", ["concentrador_nome", "concentrador_status", "cpu_uso", "memoria_uso", "concentradores_lista", "alertas_ativos"]],
  ["Alerta", ["condicao_valor", "janela"]],
  ["Tempo", ["saudacao", "data", "hora", "nome_relatorio"]],
  ["Blocos", ["se_instaveis}…{fim", "se_quedas_periodo}…{fim"]],
];

function describe(r: Rep) {
  if (r.trigger_type === "interval") return `A cada ${INTERVALS.find(([v]) => v === r.interval_minutes)?.[1] ?? `${r.interval_minutes} min`}`;
  if (r.trigger_type === "fixed") return `Horários: ${r.fixed_times.join(", ")}`;
  const c = CONDITIONS[r.condition_key ?? ""];
  return `Alerta: ${c?.label ?? "?"}${r.condition_key === "concentrador_down" ? "" : ` (${r.condition_threshold})`}`;
}

export function ReportBuilder({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Rep | null>(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [timeInput, setTimeInput] = useState("12:00");
  const [phoneInput, setPhoneInput] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  const repsQ = useQuery({
    queryKey: ["custom-reports"], refetchInterval: 30000,
    queryFn: async () => ((await supabase.from("custom_reports").select("*").order("created_at")).data ?? []) as Rep[],
  });
  const concQ = useQuery({
    queryKey: ["concs-min"],
    queryFn: async () => (await supabase.from("concentradores").select("id,nome").order("nome")).data ?? [],
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["custom-reports"] });
  const toggle = async (r: Rep, v: boolean) => {
    const { error } = await supabase.from("custom_reports").update({ enabled: v }).eq("id", r.id!);
    if (error) return toast.error(error.message);
    refresh();
  };
  const remove = async (r: Rep) => {
    if (!confirm(`Excluir "${r.nome}"?`)) return;
    await supabase.from("custom_reports").delete().eq("id", r.id!);
    refresh();
  };
  const save = async () => {
    if (!edit) return;
    if (!edit.nome.trim()) return toast.error("Dê um nome ao relatório");
    if (!edit.template.trim()) return toast.error("Escreva a mensagem");
    const { id, last_sent_at: _a, last_success: _b, last_error: _c, ...row } = edit as Rep & Record<string, unknown>;
    delete (row as Record<string, unknown>).created_at; delete (row as Record<string, unknown>).updated_at; delete (row as Record<string, unknown>).organization_id;
    const { error } = id ? await supabase.from("custom_reports").update(row).eq("id", id) : await supabase.from("custom_reports").insert(row);
    if (error) return toast.error(error.message);
    toast.success("Relatório salvo");
    setEdit(null); refresh();
  };
  const run = async (action: "report_preview" | "report_test", r: Rep) => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("notify-whatsapp", { body: { action, report: r } });
    setBusy(false);
    if (error || data?.error) return toast.error(data?.error ?? error?.message ?? "Falha");
    if (action === "report_preview") setPreview(data.text); else toast.success("Teste enviado no WhatsApp");
  };
  const insertVar = (v: string) => {
    if (!edit) return;
    const tag = v.includes("…") ? `{${v.replace("…", "\n")}}` : `{${v}}`;
    const el = ta.current; const pos = el?.selectionStart ?? edit.template.length;
    const t = edit.template.slice(0, pos) + tag + edit.template.slice(el?.selectionEnd ?? pos);
    setEdit({ ...edit, template: t });
    setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + tag.length, pos + tag.length); }, 0);
  };

  const reps = repsQ.data ?? [];
  const Icon = (t: Rep["trigger_type"]) => (t === "interval" ? Clock : t === "fixed" ? CalendarClock : Zap);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Crie quantos relatórios quiser e ligue ou desligue com um clique.</p>
        {isAdmin && <Button size="sm" onClick={() => { setEdit({ ...blank }); setPreview(""); }}><Plus className="mr-1 h-4 w-4" />Novo relatório</Button>}
      </div>
      {reps.length === 0 && <Card className="p-6 text-center text-sm text-muted-foreground">Nenhum relatório criado ainda.</Card>}
      {reps.map((r) => {
        const I = Icon(r.trigger_type);
        return (
          <Card key={r.id} className={`bg-gradient-card p-4 shadow-card ${r.enabled ? "" : "opacity-60"}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-[220px] flex-1 items-start gap-3">
                <I className="mt-0.5 h-5 w-5 text-primary" />
                <div>
                  <div className="font-medium">{r.nome}</div>
                  <div className="text-xs text-muted-foreground">
                    {describe(r)} · {r.concentrador_id ? concQ.data?.find((c) => c.id === r.concentrador_id)?.nome ?? "concentrador" : "Toda a rede"} · {r.phones.length ? `${r.phones.length} contato(s)` : "Todos os contatos"}
                  </div>
                  <div className="mt-1 text-xs">
                    {r.last_sent_at ? (
                      <span className={r.last_success === false ? "text-destructive" : "text-muted-foreground"}>
                        Último envio {timeAgo(r.last_sent_at)} {r.last_success === false ? `— falhou: ${r.last_error ?? ""}` : "✓"}
                      </span>
                    ) : <span className="text-muted-foreground">Ainda não enviado</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={r.enabled ? "default" : "secondary"}>{r.enabled ? "Ativo" : "Inativo"}</Badge>
                <Switch checked={r.enabled} disabled={!isAdmin} onCheckedChange={(v) => toggle(r, v)} />
                {isAdmin && <>
                  <Button size="icon" variant="ghost" onClick={() => { setEdit({ ...r }); setPreview(""); }} aria-label="Editar"><Pencil className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" onClick={() => remove(r)} aria-label="Excluir"><Trash2 className="h-4 w-4" /></Button>
                </>}
              </div>
            </div>
          </Card>
        );
      })}

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader><DialogTitle>{edit?.id ? "Editar relatório" : "Novo relatório"}</DialogTitle></DialogHeader>
          {edit && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div><Label>Nome</Label><Input value={edit.nome} onChange={(e) => setEdit({ ...edit, nome: e.target.value })} placeholder="Ex: Status a cada 30 min" /></div>
                <div><Label>Concentrador</Label>
                  <Select value={edit.concentrador_id ?? "all"} onValueChange={(v) => setEdit({ ...edit, concentrador_id: v === "all" ? null : v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Toda a rede</SelectItem>
                      {(concQ.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.nome}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label>Quando enviar</Label>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {([["interval", "Por intervalo", Clock], ["fixed", "Horários fixos", CalendarClock], ["condition", "Alerta (condição)", Zap]] as const).map(([k, l, I]) => (
                    <Button key={k} type="button" variant={edit.trigger_type === k ? "default" : "outline"} onClick={() => setEdit({ ...edit, trigger_type: k })}><I className="mr-1 h-4 w-4" />{l}</Button>
                  ))}
                </div>
              </div>

              {edit.trigger_type === "interval" && (
                <div><Label>Enviar a cada</Label>
                  <Select value={String(edit.interval_minutes)} onValueChange={(v) => setEdit({ ...edit, interval_minutes: Number(v) })}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>{INTERVALS.map(([v, l]) => <SelectItem key={v} value={String(v)}>{l}</SelectItem>)}</SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">O sistema confere a cada 2 minutos, então intervalos menores saem a cada ~2 min.</p>
                </div>
              )}
              {edit.trigger_type === "fixed" && (
                <div><Label>Horários</Label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {edit.fixed_times.map((t) => <Badge key={t} variant="secondary" className="cursor-pointer" onClick={() => setEdit({ ...edit, fixed_times: edit.fixed_times.filter((x) => x !== t) })}>{t} ✕</Badge>)}
                    <Input type="time" value={timeInput} onChange={(e) => setTimeInput(e.target.value)} className="h-8 w-28" />
                    <Button size="sm" variant="outline" onClick={() => timeInput && !edit.fixed_times.includes(timeInput) && setEdit({ ...edit, fixed_times: [...edit.fixed_times, timeInput].sort() })}>Adicionar</Button>
                  </div>
                </div>
              )}
              {edit.trigger_type === "condition" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><Label>Condição</Label>
                    <Select value={edit.condition_key ?? "mass_disconnect"} onValueChange={(v) => setEdit({ ...edit, condition_key: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{Object.entries(CONDITIONS).map(([k, c]) => <SelectItem key={k} value={k}>{c.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {edit.condition_key !== "concentrador_down" && (
                    <div><Label>{CONDITIONS[edit.condition_key ?? ""]?.thr}</Label><Input type="number" value={edit.condition_threshold} onChange={(e) => setEdit({ ...edit, condition_threshold: Number(e.target.value) })} /></div>
                  )}
                  {edit.condition_key === "mass_disconnect" && (
                    <div><Label>Dentro de (minutos)</Label><Input type="number" min={1} max={60} value={edit.condition_window_minutes} onChange={(e) => setEdit({ ...edit, condition_window_minutes: Number(e.target.value) })} /></div>
                  )}
                  <div><Label>Não repetir por</Label>
                    <Select value={String(edit.cooldown_minutes)} onValueChange={(v) => setEdit({ ...edit, cooldown_minutes: Number(v) })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{COOLDOWNS.map(([v, l]) => <SelectItem key={v} value={String(v)}>{l}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              <div><Label>Dias</Label>
                <div className="mt-1 flex gap-1">
                  {DAYS.map((d, i) => <Button key={d} size="sm" type="button" variant={edit.days.includes(i) ? "default" : "outline"} onClick={() => setEdit({ ...edit, days: edit.days.includes(i) ? edit.days.filter((x) => x !== i) : [...edit.days, i].sort() })}>{d}</Button>)}
                </div>
              </div>

              <div><Label>Destinatários (vazio = todos os contatos)</Label>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {edit.phones.map((p) => <Badge key={p} variant="secondary" className="cursor-pointer" onClick={() => setEdit({ ...edit, phones: edit.phones.filter((x) => x !== p) })}>{p} ✕</Badge>)}
                  <Input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="5511999999999" className="h-8 w-44" />
                  <Button size="sm" variant="outline" onClick={() => {
                    const n = phoneInput.replace(/\D/g, "");
                    if (n.length < 12 || n.length > 13) return toast.error("Use DDI + DDD + número");
                    if (!edit.phones.includes(n)) setEdit({ ...edit, phones: [...edit.phones, n] });
                    setPhoneInput("");
                  }}>Adicionar</Button>
                </div>
              </div>

              <div>
                <Label>Mensagem</Label>
                <div className="mb-2 mt-1 space-y-1">
                  {VARS.map(([g, vs]) => (
                    <div key={g} className="flex flex-wrap items-center gap-1">
                      <span className="w-24 text-xs text-muted-foreground">{g}</span>
                      {vs.map((v) => <Badge key={v} variant="outline" className="cursor-pointer font-mono text-[11px] hover:bg-accent" onClick={() => insertVar(v)}>{`{${v}}`}</Badge>)}
                    </div>
                  ))}
                </div>
                <Textarea ref={ta} rows={9} className="font-mono text-sm" value={edit.template} onChange={(e) => setEdit({ ...edit, template: e.target.value })} />
                <p className="mt-1 text-xs text-muted-foreground">Clique numa variável para inserir. Use *texto* para negrito. Blocos {"{se_x}…{fim}"} só aparecem quando o valor for maior que zero.</p>
              </div>

              {preview && (
                <Card className="whitespace-pre-wrap bg-muted p-3 text-sm">{preview}</Card>
              )}
            </div>
          )}
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" disabled={busy} onClick={() => edit && run("report_preview", edit)}><Eye className="mr-1 h-4 w-4" />Pré-visualizar</Button>
            <Button variant="outline" disabled={busy} onClick={() => edit && run("report_test", edit)}><Send className="mr-1 h-4 w-4" />Enviar teste</Button>
            <Button onClick={save}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
