CREATE TABLE public.custom_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  nome text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  trigger_type text NOT NULL DEFAULT 'interval',
  interval_minutes integer NOT NULL DEFAULT 60,
  fixed_times text[] NOT NULL DEFAULT '{08:00}',
  days integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  condition_key text,
  condition_threshold integer NOT NULL DEFAULT 10,
  condition_window_minutes integer NOT NULL DEFAULT 5,
  cooldown_minutes integer NOT NULL DEFAULT 30,
  concentrador_id uuid REFERENCES public.concentradores(id) ON DELETE SET NULL,
  phones text[] NOT NULL DEFAULT '{}',
  template text NOT NULL DEFAULT '',
  last_sent_at timestamptz,
  last_success boolean,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_reports TO authenticated;
GRANT ALL ON public.custom_reports TO service_role;
ALTER TABLE public.custom_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Autenticados veem relatorios" ON public.custom_reports FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins gerenciam relatorios" ON public.custom_reports FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER custom_reports_updated BEFORE UPDATE ON public.custom_reports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
INSERT INTO public.custom_reports (nome, trigger_type, interval_minutes, template) VALUES
('Status a cada hora', 'interval', 60, E'🔔 *{saudacao}! {nome_relatorio}*\n📅 {data} às {hora}\n\n👥 Online: *{online_total}*\n📉 Quedas no período: *{quedas_periodo}*\n⚡ CPU: *{cpu_uso}%* | RAM: *{memoria_uso}%*\n{se_instaveis}⚠️ {clientes_instaveis} clientes oscilando!{fim}');
INSERT INTO public.custom_reports (nome, trigger_type, fixed_times, template) VALUES
('Fechamento do plantão', 'fixed', '{08:00,18:00}', E'📊 *{nome_relatorio}* — {data}\n\n👥 Online: *{online_total}*\n📉 Quedas 24h: *{quedas_24h}*\n🔔 Alertas ativos: *{alertas_ativos}*\n\n*Concentradores*\n{concentradores_lista}\n\n*Top quedas*\n{top_quedas}');
INSERT INTO public.custom_reports (nome, trigger_type, condition_key, condition_threshold, condition_window_minutes, template) VALUES
('Alerta de queda em massa', 'condition', 'mass_disconnect', 10, 5, E'🚨 *{nome_relatorio}*\n{condicao_valor} clientes caíram nos últimos {janela} min em *{concentrador_nome}*.\n🕒 {hora}');