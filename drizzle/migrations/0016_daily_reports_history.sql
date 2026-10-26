CREATE TABLE public.daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  report_date date NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  top_drops jsonb NOT NULL DEFAULT '[]'::jsonb,
  top_consumers jsonb NOT NULL DEFAULT '[]'::jsonb,
  message_text text,
  status text NOT NULL DEFAULT 'generated',
  sent_at timestamptz
);
CREATE UNIQUE INDEX daily_reports_org_date ON public.daily_reports (coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid), report_date);
GRANT SELECT ON public.daily_reports TO authenticated;
GRANT ALL ON public.daily_reports TO service_role;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authorized read daily reports" ON public.daily_reports FOR SELECT TO authenticated
USING (public.is_authorized(auth.uid()) AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id) OR public.has_role(auth.uid(),'admin')));

-- Consolida D-1 (America/Bahia) e grava; idempotente por data (recalcula se ainda não enviado)
CREATE OR REPLACE FUNCTION public.build_daily_report(_date date)
RETURNS public.daily_reports
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE t0 timestamptz := (_date::timestamp AT TIME ZONE 'America/Bahia'); t1 timestamptz := ((_date+1)::timestamp AT TIME ZONE 'America/Bahia');
 r public.daily_reports; drops jsonb; cons jsonb; summ jsonb;
BEGIN
 IF auth.role() <> 'service_role' AND NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
 SELECT coalesce(jsonb_agg(x ORDER BY x.count DESC, x.username),'[]') INTO drops FROM (
   SELECT e.concentrador_id, c.nome AS concentrador_nome, e.username, count(*)::int AS count
   FROM eventos e LEFT JOIN concentradores c ON c.id=e.concentrador_id
   WHERE e.tipo='disconnect' AND e.created_at>=t0 AND e.created_at<t1 AND e.username IS NOT NULL
   GROUP BY 1,2,3 ORDER BY count(*) DESC, e.username LIMIT 10) x;
 SELECT coalesce(jsonb_agg(x ORDER BY x.total_bytes DESC),'[]') INTO cons FROM (
   SELECT s.concentrador_id, c.nome AS concentrador_nome, s.username, max(s.bytes_in) AS bytes_in, max(s.bytes_out) AS bytes_out,
     max(coalesce(s.bytes_in,0)+coalesce(s.bytes_out,0)) AS total_bytes
   FROM pppoe_sessions s LEFT JOIN concentradores c ON c.id=s.concentrador_id
   WHERE s.ultima_atualizacao>=t0 AND s.ultima_atualizacao<t1 AND (s.bytes_in IS NOT NULL OR s.bytes_out IS NOT NULL)
   GROUP BY 1,2,3 ORDER BY 6 DESC LIMIT 10) x;
 summ := jsonb_build_object(
   'individual_drops',(SELECT count(*) FROM eventos WHERE tipo='disconnect' AND created_at>=t0 AND created_at<t1),
   'clients_with_drops',(SELECT count(DISTINCT (concentrador_id,username)) FROM eventos WHERE tipo='disconnect' AND created_at>=t0 AND created_at<t1),
   'mass_incidents',(SELECT count(*) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND created_at>=t0 AND created_at<t1),
   'snmp_down_events',(SELECT count(*) FROM eventos WHERE tipo='device_down' AND metadata->>'source'='snmp' AND created_at>=t0 AND created_at<t1),
   'alerts',(SELECT count(*) FROM alertas WHERE created_at>=t0 AND created_at<t1),
   'consumption_source','Fotografias API (bytes acumulados da sessão; aproximado)');
 INSERT INTO daily_reports(report_date,summary,top_drops,top_consumers) VALUES(_date,summ,drops,cons)
 ON CONFLICT (coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid), report_date)
 DO UPDATE SET summary=EXCLUDED.summary, top_drops=EXCLUDED.top_drops, top_consumers=EXCLUDED.top_consumers, generated_at=now()
   WHERE daily_reports.status <> 'sent'
 RETURNING * INTO r;
 IF r.id IS NULL THEN SELECT * INTO r FROM daily_reports WHERE organization_id IS NULL AND report_date=_date; END IF;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.build_daily_report(date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.build_daily_report(date) TO authenticated, service_role;