CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE public.notification_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  api_url text,
  api_token text,
  instance text,
  phones text[] NOT NULL DEFAULT '{}',
  daily_report_enabled boolean NOT NULL DEFAULT true,
  daily_report_hour integer NOT NULL DEFAULT 8,
  last_daily_sent_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_settings TO authenticated;
GRANT ALL ON public.notification_settings TO service_role;
ALTER TABLE public.notification_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage notif settings" ON public.notification_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_notif_settings_updated BEFORE UPDATE ON public.notification_settings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  rule_key text NOT NULL UNIQUE,
  label text NOT NULL,
  descricao text,
  enabled boolean NOT NULL DEFAULT true,
  send_whatsapp boolean NOT NULL DEFAULT true,
  include_in_daily boolean NOT NULL DEFAULT true,
  threshold integer NOT NULL DEFAULT 0,
  threshold_label text,
  cooldown_minutes integer NOT NULL DEFAULT 30,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.alert_rules TO authenticated;
GRANT ALL ON public.alert_rules TO service_role;
ALTER TABLE public.alert_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth view rules" ON public.alert_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "admins manage rules" ON public.alert_rules FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
CREATE TRIGGER trg_alert_rules_updated BEFORE UPDATE ON public.alert_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.notification_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text,
  dedupe_key text,
  message text NOT NULL,
  success boolean NOT NULL DEFAULT true,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.notification_log TO authenticated;
GRANT ALL ON public.notification_log TO service_role;
ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth view notif log" ON public.notification_log FOR SELECT TO authenticated USING (true);
CREATE INDEX idx_notif_log_dedupe ON public.notification_log(dedupe_key, created_at DESC);

INSERT INTO public.alert_rules (rule_key,label,descricao,threshold,threshold_label,cooldown_minutes) VALUES
 ('concentrador_down','Concentrador offline','Avisa quando um concentrador para de responder',0,NULL,30),
 ('mass_disconnect','Queda em massa','Muitos clientes caindo em 5 minutos no mesmo concentrador',10,'clientes em 5 min',15),
 ('client_unstable','Cliente instável','Cliente com muitas quedas nas últimas 24h',5,'quedas em 24h',720),
 ('cpu_high','CPU alta','Uso de CPU do concentrador acima do limite',85,'% de CPU',60),
 ('memory_high','Memória alta','Uso de memória do concentrador acima do limite',90,'% de memória',60),
 ('online_drop','Queda de clientes online','Total de clientes online caiu abaixo do limite',0,'clientes online (0 = desligado)',30),
 ('system_alerts','Alertas do sistema','Repassa alertas críticos gerados pelo sistema',0,NULL,0);