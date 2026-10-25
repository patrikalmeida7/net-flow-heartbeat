import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Send, FileText, Bell, CalendarClock, History, X, Moon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { timeAgo } from "@/lib/format";
import { toast } from "sonner";
import { WhatsAppConnect } from "@/components/WhatsAppConnect";

type Settings = {
  id?: string; enabled: boolean; api_url: string; api_token: string; instance: string; phones: string[];
  daily_report_enabled: boolean; daily_report_hour: number; daily_report_minute: number; report_days: number[];
  evening_report_enabled: boolean; evening_report_hour: number;
  quiet_enabled: boolean; quiet_start_hour: number; quiet_end_hour: number;
};
const empty: Settings = {
  enabled: false, api_url: "", api_token: "", instance: "", phones: [],
  daily_report_enabled: true, daily_report_hour: 8, daily_report_minute: 0, report_days: [0, 1, 2, 3, 4, 5, 6],
  evening_report_enabled: false, evening_report_hour: 18, quiet_enabled: false, quiet_start_hour: 23, quiet_end_hour: 6,
};
const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const COOLDOWNS = [[0, "Sempre"], [5, "5 min"], [15, "15 min"], [30, "30 min"], [60, "1 hora"], [180, "3 horas"], [360, "6 horas"], [720, "12 horas"], [1440, "1 dia"], [100000, "Uma vez só"]] as const;
const TOLERANCES = [[0, "Imediato"], [1, "1 min"], [2, "2 min"], [5, "5 min"], [10, "10 min"], [15, "15 min"]] as const;
const WINDOWS = [[1, "1 min"], [2, "2 min"], [5, "5 min"], [10, "10 min"], [15, "15 min"], [30, "30 min"]] as const;
const pad = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function Opt({ value, options, onChange, disabled, className = "w-28" }: { value: number; options: readonly (readonly [number, string])[]; onChange: (v: number) => void; disabled?: boolean; className?: string }) {
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))} disabled={disabled}>
      <SelectTrigger className={`h-8 ${className}`}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([v, l]) => <SelectItem key={v} value={String(v)}>{l}</SelectItem>)}</SelectContent>
    </Select>
  );
}
const hourOpts = HOURS.map((h) => [h, `${pad(h)}:00`] as const);

export default function Relatorios() {
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const [s, setS] = useState<Settings>(empty);
  const [phoneInput, setPhoneInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [logFilter, setLogFilter] = useState<"all" | "ok" | "fail">("all");

  const settingsQ = useQuery({
    queryKey: ["notif-settings"], enabled: isAdmin,
    queryFn: async () => (await supabase.from("notification_settings").select("*").limit(1).maybeSingle()).data,
  });
  const rulesQ = useQuery({
    queryKey: ["alert-rules"],
    queryFn: async () => (await supabase.from("alert_rules").select("*").order("created_at")).data ?? [],
  });
  const logQ = useQuery({
    queryKey: ["notif-log"], refetchInterval: 30000,
    queryFn: async () => (await supabase.from("notification_log").select("*").order("created_at", { ascending: false }).limit(100)).data ?? [],
  });
  const resumoQ = useQuery({
    queryKey: ["relatorio-resumo"], refetchInterval: 30000,
    queryFn: async () => {
      const since = new Date(Date.now() - 86400000).toISOString();
      const [on, drops, al] = await Promise.all([
        supabase.from("pppoe_sessions").select("id", { count: "exact", head: true }).eq("online", true),
        supabase.from("eventos").select("id", { count: "exact", head: true }).eq("tipo", "disconnect").gte("created_at", since),
        supabase.from("alertas").select("id", { count: "exact", head: true }).eq("status", "active"),
      ]);
      return { online: on.count ?? 0, drops: drops.count ?? 0, alertas: al.count ?? 0 };
    },
  });

  useEffect(() => {
    const d = settingsQ.data;
    if (d) setS({
      id: d.id, enabled: d.enabled, api_url: d.api_url ?? "", api_token: d.api_token ?? "", instance: d.instance ?? "", phones: d.phones ?? [],
      daily_report_enabled: d.daily_report_enabled, daily_report_hour: d.daily_report_hour, daily_report_minute: d.daily_report_minute ?? 0,
      report_days: d.report_days ?? empty.report_days, evening_report_enabled: d.evening_report_enabled ?? false, evening_report_hour: d.evening_report_hour ?? 18,
      quiet_enabled: d.quiet_enabled ?? false, quiet_start_hour: d.quiet_start_hour ?? 23, quiet_end_hour: d.quiet_end_hour ?? 6,
    });
  }, [settingsQ.data]);

  const save = async () => {
    setBusy(true);
    const { id, ...rest } = s;
    const row = { ...rest, api_url: s.api_url.trim(), api_token: s.api_token.trim(), instance: s.instance.trim() };
    const { error } = id
      ? await supabase.from("notification_settings").update(row).eq("id", id)
      : await supabase.from("notification_settings").insert(row);
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success("Configuração salva");
    qc.invalidateQueries({ queryKey: ["notif-settings"] });
  };

  const call = async (action: "test" | "daily") => {
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("notify-whatsapp", { body: { action } });
    setBusy(false);
    if (error || data?.error) return toast.error(data?.error ?? error?.message ?? "Falha ao enviar");
    toast.success(action === "test" ? "Mensagem de teste enviada" : "Relatório enviado");
    qc.invalidateQueries({ queryKey: ["notif-log"] });
  };

  const updateRule = async (id: string, patch: Record<string, number | boolean>) => {
    const { error } = await supabase.from("alert_rules").update(patch).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["alert-rules"] });
  };

  const addPhone = () => {
    const n = phoneInput.replace(/\D/g, "");
    if (n.length < 12 || n.length > 13) return toast.error("Use DDI + DDD + número, ex: 5511999999999");
    if (!s.phones.includes(n)) setS({ ...s, phones: [...s.phones, n] });
    setPhoneInput("");
  };
  const toggleDay = (d: number) => setS({ ...s, report_days: s.report_days.includes(d) ? s.report_days.filter((x) => x !== d) : [...s.report_days, d].sort() });

  const logs = useMemo(() => (logQ.data ?? []).filter((l) => logFilter === "all" || (logFilter === "ok" ? l.success : !l.success)), [logQ.data, logFilter]);
  const rules = rulesQ.data ?? [];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Relatórios e Alertas</h1>
          <p className="text-sm text-muted-foreground">Central de notificações via WhatsApp (MultixZap)</p>
        </div>
        <Badge variant={s.enabled ? "default" : "secondary"}>{s.enabled ? "Envio automático ligado" : "Envio automático desligado"}</Badge>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {[["Clientes online", resumoQ.data?.online], ["Quedas 24h", resumoQ.data?.drops], ["Alertas ativos", resumoQ.data?.alertas], ["Regras ativas", `${rules.filter((r) => r.enabled).length}/${rules.length}`]].map(([l, v]) => (
          <Card key={l as string} className="bg-gradient-card p-4 shadow-card">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{l}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v ?? "—"}</div>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="alertas">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="alertas"><Bell className="mr-1 h-4 w-4" />Alertas</TabsTrigger>
          <TabsTrigger value="agenda"><CalendarClock className="mr-1 h-4 w-4" />Agendamento</TabsTrigger>
          {isAdmin && <TabsTrigger value="conexao"><MessageCircle className="mr-1 h-4 w-4" />Conexão e contatos</TabsTrigger>}
          <TabsTrigger value="historico"><History className="mr-1 h-4 w-4" />Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="alertas" className="space-y-3">
          {rules.map((r) => (
            <Card key={r.id} className={`bg-gradient-card p-4 shadow-card ${r.enabled ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[200px] flex-1">
                  <div className="font-medium">{r.label}</div>
                  <div className="text-xs text-muted-foreground">{r.descricao}</div>
                </div>
                <label className="flex items-center gap-2 text-sm"><Switch checked={r.enabled} disabled={!isAdmin} onCheckedChange={(v) => updateRule(r.id, { enabled: v })} />Ativo</label>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {r.threshold_label && (
                  <div><Label className="text-xs">Limite</Label>
                    <div className="flex items-center gap-2">
                      <Input type="number" className="h-8 w-20" defaultValue={r.threshold} disabled={!isAdmin || !r.enabled}
                        onBlur={(e) => Number(e.target.value) !== r.threshold && updateRule(r.id, { threshold: Number(e.target.value) || 0 })} />
                      <span className="text-xs text-muted-foreground">{r.threshold_label.replace(" em 5 min", "")}</span>
                    </div>
                  </div>
                )}
                {r.rule_key === "mass_disconnect" && (
                  <div><Label className="text-xs">Janela de tempo</Label>
                    <Opt value={r.window_minutes} options={WINDOWS} disabled={!isAdmin || !r.enabled} onChange={(v) => updateRule(r.id, { window_minutes: v })} /></div>
                )}
                {r.rule_key === "concentrador_down" && (
                  <div><Label className="text-xs">Tolerância antes de avisar</Label>
                    <Opt value={r.tolerance_minutes} options={TOLERANCES} disabled={!isAdmin || !r.enabled} onChange={(v) => updateRule(r.id, { tolerance_minutes: v })} /></div>
                )}
                <div><Label className="text-xs">Repetir aviso a cada</Label>
                  <Opt value={r.cooldown_minutes} options={COOLDOWNS} disabled={!isAdmin || !r.enabled} onChange={(v) => updateRule(r.id, { cooldown_minutes: v })} /></div>
                <label className="flex items-center gap-2 self-end text-xs"><Switch checked={r.send_whatsapp} disabled={!isAdmin || !r.enabled} onCheckedChange={(v) => updateRule(r.id, { send_whatsapp: v })} />Enviar na hora</label>
                <label className="flex items-center gap-2 self-end text-xs"><Switch checked={r.include_in_daily} disabled={!isAdmin || !r.enabled} onCheckedChange={(v) => updateRule(r.id, { include_in_daily: v })} />No relatório</label>
              </div>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="agenda">
          <Card className="bg-gradient-card p-5 shadow-card space-y-5">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex min-w-[200px] items-center gap-2 text-sm font-medium"><Switch checked={s.daily_report_enabled} disabled={!isAdmin} onCheckedChange={(v) => setS({ ...s, daily_report_enabled: v })} />Resumo da manhã</label>
              <Opt value={s.daily_report_hour} options={hourOpts} disabled={!isAdmin} onChange={(v) => setS({ ...s, daily_report_hour: v })} />
              <Opt value={s.daily_report_minute} options={[0, 15, 30, 45].map((m) => [m, `:${pad(m)}`] as const)} disabled={!isAdmin} className="w-20" onChange={(v) => setS({ ...s, daily_report_minute: v })} />
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex min-w-[200px] items-center gap-2 text-sm font-medium"><Switch checked={s.evening_report_enabled} disabled={!isAdmin} onCheckedChange={(v) => setS({ ...s, evening_report_enabled: v })} />Fechamento do dia</label>
              <Opt value={s.evening_report_hour} options={hourOpts} disabled={!isAdmin} onChange={(v) => setS({ ...s, evening_report_hour: v })} />
            </div>
            <div>
              <Label className="text-xs">Dias de envio</Label>
              <div className="mt-1 flex flex-wrap gap-2">
                {DAYS.map((d, i) => (
                  <Button key={d} size="sm" variant={s.report_days.includes(i) ? "default" : "outline"} disabled={!isAdmin} onClick={() => toggleDay(i)}>{d}</Button>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-border p-4">
              <label className="flex items-center gap-2 text-sm font-medium"><Moon className="h-4 w-4" /><Switch checked={s.quiet_enabled} disabled={!isAdmin} onCheckedChange={(v) => setS({ ...s, quiet_enabled: v })} />Horário de silêncio</label>
              <p className="mt-1 text-xs text-muted-foreground">Nesse período só chegam avisos críticos (concentrador offline, queda em massa, clientes online abaixo do limite).</p>
              <div className="mt-2 flex items-center gap-2 text-sm">
                das <Opt value={s.quiet_start_hour} options={hourOpts} disabled={!isAdmin || !s.quiet_enabled} onChange={(v) => setS({ ...s, quiet_start_hour: v })} />
                até <Opt value={s.quiet_end_hour} options={hourOpts} disabled={!isAdmin || !s.quiet_enabled} onChange={(v) => setS({ ...s, quiet_end_hour: v })} />
              </div>
            </div>
            {isAdmin && (
              <div className="flex flex-wrap justify-between gap-2">
                <Button variant="outline" onClick={() => call("daily")} disabled={busy || !s.id}><FileText className="mr-1 h-4 w-4" />Enviar relatório agora</Button>
                <Button onClick={save} disabled={busy}>Salvar alterações</Button>
              </div>
            )}
          </Card>
        </TabsContent>

        {isAdmin && (
          <TabsContent value="conexao">
            <Card className="bg-gradient-card p-5 shadow-card">
              <div className="mb-4 flex items-center gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">MultixZap</h2>
                <label className="ml-auto flex items-center gap-2 text-sm"><Switch checked={s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} />Envio automático</label>
              </div>
              <div className="grid gap-3 md:grid-cols-3">
                <div><Label>Endereço da API</Label><Input placeholder="https://api.multixzap.com.br" value={s.api_url} onChange={(e) => setS({ ...s, api_url: e.target.value })} /></div>
                <div><Label>Instância</Label><Input placeholder="noc" value={s.instance} onChange={(e) => setS({ ...s, instance: e.target.value })} /></div>
                <div><Label>Token / API Key</Label><Input type="password" value={s.api_token} onChange={(e) => setS({ ...s, api_token: e.target.value })} /></div>
              </div>
              <div className="mt-4">
                <Label>Quem recebe os avisos</Label>
                <div className="mt-1 flex gap-2">
                  <Input placeholder="5511999999999" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPhone()} className="max-w-xs" />
                  <Button variant="secondary" onClick={addPhone}>Adicionar</Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.phones.length === 0 && <span className="text-xs text-muted-foreground">Nenhum número cadastrado.</span>}
                  {s.phones.map((p) => (
                    <Badge key={p} variant="outline" className="gap-1">+{p}
                      <button onClick={() => setS({ ...s, phones: s.phones.filter((x) => x !== p) })} aria-label={`Remover ${p}`}><X className="h-3 w-3" /></button>
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="mt-4"><WhatsAppConnect ready={!!(settingsQ.data?.api_url && settingsQ.data?.api_token && settingsQ.data?.instance)} /></div>
              <div className="mt-4 flex flex-wrap justify-between gap-2">
                <Button variant="secondary" onClick={() => call("test")} disabled={busy || !s.id}><Send className="mr-1 h-4 w-4" />Enviar teste</Button>
                <Button onClick={save} disabled={busy}>Salvar alterações</Button>
              </div>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="historico">
          <Card className="bg-gradient-card p-5 shadow-card">
            <div className="mb-3 flex gap-2">
              {([["all", "Todas"], ["ok", "Enviadas"], ["fail", "Falhas"]] as const).map(([k, l]) => (
                <Button key={k} size="sm" variant={logFilter === k ? "default" : "outline"} onClick={() => setLogFilter(k)}>{l}</Button>
              ))}
            </div>
            {logs.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nenhuma mensagem.</p>}
            <div className="space-y-2">
              {logs.map((l) => (
                <div key={l.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className={l.success ? "text-status-online" : "text-severity-critical"}>{l.success ? "Enviada" : "Falhou"} · {l.rule_key}</span>
                    <span>{timeAgo(l.created_at)}</span>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap font-sans">{l.message}</pre>
                  {l.error && <p className="mt-1 text-xs text-severity-critical">{l.error}</p>}
                </div>
              ))}
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
