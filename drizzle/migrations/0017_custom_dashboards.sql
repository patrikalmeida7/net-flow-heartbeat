CREATE TABLE public.custom_dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  nome text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  panels jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_dashboards TO authenticated;
GRANT ALL ON public.custom_dashboards TO service_role;
ALTER TABLE public.custom_dashboards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authorized read dashboards" ON public.custom_dashboards FOR SELECT TO authenticated
 USING (public.is_authorized(auth.uid()) AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));
CREATE POLICY "Admins manage dashboards" ON public.custom_dashboards FOR ALL TO authenticated
 USING (public.has_role(auth.uid(),'admin') AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)))
 WITH CHECK (public.has_role(auth.uid(),'admin') AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));
CREATE TRIGGER custom_dashboards_updated BEFORE UPDATE ON public.custom_dashboards FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Série agregada no servidor (avg/max por bucket), respeita RLS de metric_samples
CREATE OR REPLACE FUNCTION public.metric_series(_concentrador uuid, _rbs uuid, _interface uuid, _kinds text[], _since timestamptz, _until timestamptz DEFAULT now(), _points int DEFAULT 240)
RETURNS TABLE(bucket_at timestamptz, kind text, avg_value double precision, max_value double precision, samples bigint, bucket_seconds int)
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  WITH p AS (SELECT GREATEST(30, ceil(extract(epoch FROM (_until-_since)) / LEAST(GREATEST(_points,10),1000)))::int AS sec)
  SELECT to_timestamp(floor(extract(epoch FROM s.collected_at)/p.sec)*p.sec), s.kind::text, avg(s.value), max(s.value), count(*), p.sec
  FROM metric_samples s, p
  WHERE s.source='snmp' AND s.collected_at >= _since AND s.collected_at < _until
    AND s.kind::text = ANY(_kinds)
    AND (_concentrador IS NULL OR s.concentrador_id=_concentrador)
    AND (_rbs IS NULL OR s.rbs_id=_rbs)
    AND s.interface_id IS NOT DISTINCT FROM _interface
  GROUP BY 1,2,p.sec ORDER BY 1
$$;

-- Catálogo: métricas efetivamente observadas por equipamento (últimos 7 dias)
CREATE OR REPLACE FUNCTION public.metric_catalog(_concentrador uuid, _rbs uuid)
RETURNS TABLE(kind text, interface_id uuid, last_at timestamptz, samples bigint)
LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT s.kind::text, s.interface_id, max(s.collected_at), count(*)
  FROM metric_samples s
  WHERE s.source='snmp' AND s.collected_at >= now()-interval '7 days'
    AND (_concentrador IS NULL OR s.concentrador_id=_concentrador)
    AND (_rbs IS NULL OR s.rbs_id=_rbs)
  GROUP BY 1,2
$$;
GRANT EXECUTE ON FUNCTION public.metric_series(uuid,uuid,uuid,text[],timestamptz,timestamptz,int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.metric_catalog(uuid,uuid) TO authenticated;