import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Send, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/format";
import { toast } from "sonner";

type Settings = {
  id?: string; enabled: boolean; api_url: string; api_token: string; instance: string;
  phones: string; daily_report_enabled: boolean; daily_report_hour: number;
};
const empty: Settings = { enabled: false, api_url: "", api_token: "", instance: "", phones: "", daily_report_enabled: true, daily_report_hour: 8 };

export default function Relatorios() {
  const qc = useQueryClient();
  const { hasRole } = useAuth();
  const isAdmin = hasRole("admin");
  const [s, setS] = useState<Settings>(empty);
  const [busy, setBusy] = useState(false);

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
    queryFn: async () => (await supabase.from("notification_log").select("*").order("created_at", { ascending: false }).limit(30)).data ?? [],
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
    if (d) setS({ id: d.id, enabled: d.enabled, api_url: d.api_url ?? "", api_token: d.api_token ?? "", instance: d.instance ?? "",
      phones: (d.phones ?? []).join(", "), daily_report_enabled: d.daily_report_enabled, daily_report_hour: d.daily_report_hour });
  }, [settingsQ.data]);

  const save = async () => {
    setBusy(true);
    const row = { enabled: s.enabled, api_url: s.api_url.trim(), api_token: s.api_token.trim(), instance: s.instance.trim(),
      phones: s.phones.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean),
      daily_report_enabled: s.daily_report_enabled, daily_report_hour: Math.min(23, Math.max(0, Number(s.daily_report_hour) || 0)) };
    const { error } = s.id
      ? await supabase.from("notification_settings").update(row).eq("id", s.id)
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

  const updateRule = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await supabase.from("alert_rules").update(patch).eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["alert-rules"] });
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Relatórios e Alertas</h1>
        <p className="text-sm text-muted-foreground">Escolha com cliques o que vai para o WhatsApp (MultixZap) e o que entra no relatório diário</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[["Clientes online", resumoQ.data?.online], ["Quedas 24h", resumoQ.data?.drops], ["Alertas ativos", resumoQ.data?.alertas]].map(([l, v]) => (
          <Card key={l as string} className="bg-gradient-card p-4 shadow-card">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">{l}</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{v ?? "—"}</div>
          </Card>
        ))}
      </div>

      <Card className="bg-gradient-card p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Quais alertas enviar</h2>
        <div className="divide-y divide-border">
          {(rulesQ.data ?? []).map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-4 py-3">
              <div className="min-w-[200px] flex-1">
                <div className="font-medium">{r.label}</div>
                <div className="text-xs text-muted-foreground">{r.descricao}</div>
              </div>
              {r.threshold_label && (
                <div className="flex items-center gap-2">
                  <Input type="number" className="h-8 w-20" defaultValue={r.threshold} disabled={!isAdmin}
                    onBlur={(e) => Number(e.target.value) !== r.threshold && updateRule(r.id, { threshold: Number(e.target.value) || 0 })} />
                  <span className="text-xs text-muted-foreground">{r.threshold_label}</span>
                </div>
              )}
              <label className="flex items-center gap-2 text-xs"><Switch checked={r.enabled} disabled={!isAdmin} onCheckedChange={(v) => updateRule(r.id, { enabled: v })} />Ativo</label>
              <label className="flex items-center gap-2 text-xs"><Switch checked={r.send_whatsapp} disabled={!isAdmin || !r.enabled} onCheckedChange={(v) => updateRule(r.id, { send_whatsapp: v })} />Na hora</label>
              <label className="flex items-center gap-2 text-xs"><Switch checked={r.include_in_daily} disabled={!isAdmin || !r.enabled} onCheckedChange={(v) => updateRule(r.id, { include_in_daily: v })} />No diário</label>
            </div>
          ))}
        </div>
      </Card>

      {isAdmin && (
        <Card className="bg-gradient-card p-5 shadow-card">
          <div className="mb-4 flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Conexão MultixZap</h2>
            <label className="ml-auto flex items-center gap-2 text-sm"><Switch checked={s.enabled} onCheckedChange={(v) => setS({ ...s, enabled: v })} />Envio automático</label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label>Endereço da API</Label><Input placeholder="https://api.multixzap.com.br" value={s.api_url} onChange={(e) => setS({ ...s, api_url: e.target.value })} /></div>
            <div><Label>Instância</Label><Input placeholder="noc" value={s.instance} onChange={(e) => setS({ ...s, instance: e.target.value })} /></div>
            <div><Label>Token / API Key</Label><Input type="password" value={s.api_token} onChange={(e) => setS({ ...s, api_token: e.target.value })} /></div>
            <div><Label>Números (separe por vírgula)</Label><Input placeholder="5511999999999" value={s.phones} onChange={(e) => setS({ ...s, phones: e.target.value })} /></div>
            <label className="flex items-center gap-2 text-sm"><Switch checked={s.daily_report_enabled} onCheckedChange={(v) => setS({ ...s, daily_report_enabled: v })} />Relatório diário automático</label>
            <div className="flex items-center gap-2"><Label>Horário (0-23h)</Label><Input type="number" className="w-20" value={s.daily_report_hour} onChange={(e) => setS({ ...s, daily_report_hour: Number(e.target.value) })} /></div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy}>Salvar</Button>
            <Button variant="secondary" onClick={() => call("test")} disabled={busy || !s.id}><Send className="mr-1 h-4 w-4" />Enviar teste</Button>
            <Button variant="outline" onClick={() => call("daily")} disabled={busy || !s.id}><FileText className="mr-1 h-4 w-4" />Enviar relatório agora</Button>
          </div>
        </Card>
      )}

      <Card className="bg-gradient-card p-5 shadow-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">Mensagens enviadas</h2>
        {(logQ.data ?? []).length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">Nenhuma mensagem ainda.</p>}
        <div className="space-y-2">
          {(logQ.data ?? []).map((l) => (
            <div key={l.id} className="rounded-md border border-border p-3 text-sm">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span className={l.success ? "text-status-online" : "text-severity-critical"}>{l.success ? "Enviada" : "Falhou"}</span>
                <span>{timeAgo(l.created_at)}</span>
              </div>
              <pre className="mt-1 whitespace-pre-wrap font-sans">{l.message}</pre>
              {l.error && <p className="mt-1 text-xs text-severity-critical">{l.error}</p>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
