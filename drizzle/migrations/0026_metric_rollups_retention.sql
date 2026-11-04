CREATE TABLE IF NOT EXISTS public.metric_hourly (
  bucket_at timestamptz NOT NULL, concentrador_id uuid, rbs_id uuid, interface_id uuid,
  kind public.metric_kind NOT NULL, avg_value double precision NOT NULL, max_value double precision NOT NULL,
  min_value double precision NOT NULL, samples integer NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS metric_hourly_uq ON public.metric_hourly (bucket_at, coalesce(concentrador_id,'00000000-0000-0000-0000-000000000000'), coalesce(rbs_id,'00000000-0000-0000-0000-000000000000'), coalesce(interface_id,'00000000-0000-0000-0000-000000000000'), kind);
CREATE INDEX IF NOT EXISTS metric_hourly_iface_idx ON public.metric_hourly (interface_id, kind, bucket_at);
CREATE INDEX IF NOT EXISTS metric_hourly_dev_idx ON public.metric_hourly (concentrador_id, rbs_id, kind, bucket_at) WHERE interface_id IS NULL;
CREATE TABLE IF NOT EXISTS public.metric_daily (LIKE public.metric_hourly);
CREATE UNIQUE INDEX IF NOT EXISTS metric_daily_uq ON public.metric_daily (bucket_at, coalesce(concentrador_id,'00000000-0000-0000-0000-000000000000'), coalesce(rbs_id,'00000000-0000-0000-0000-000000000000'), coalesce(interface_id,'00000000-0000-0000-0000-000000000000'), kind);
CREATE INDEX IF NOT EXISTS metric_daily_iface_idx ON public.metric_daily (interface_id, kind, bucket_at);
CREATE TABLE IF NOT EXISTS public.maintenance_runs (id bigserial PRIMARY KEY, job text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, result jsonb);
GRANT ALL ON public.metric_hourly, public.metric_daily, public.maintenance_runs TO service_role;
GRANT SELECT ON public.maintenance_runs TO authenticated;
ALTER TABLE public.metric_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.metric_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_runs_admin_read ON public.maintenance_runs FOR SELECT TO authenticated USING ((SELECT public.has_role((SELECT auth.uid()),'admin')));

CREATE OR REPLACE FUNCTION public.metric_maintenance(_max_hours int DEFAULT 400)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout=0 AS $$
DECLARE h timestamptz; last_h timestamptz; n_hours int:=0; d_raw bigint:=0; d_rec bigint:=0; d_ev bigint:=0; d_log bigint:=0; d_h bigint:=0; d_d bigint:=0; n bigint; run_id bigint;
 raw_cut timestamptz := now()-interval '7 days';
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
 INSERT INTO maintenance_runs(job) VALUES('metric_maintenance') RETURNING id INTO run_id;
 SELECT max(bucket_at)+interval '1 hour' INTO last_h FROM metric_hourly;
 IF last_h IS NULL THEN SELECT date_trunc('hour',min(collected_at)) INTO last_h FROM metric_samples; END IF;
 h := last_h;
 WHILE h IS NOT NULL AND h < date_trunc('hour',now()) AND n_hours < _max_hours LOOP
  INSERT INTO metric_hourly SELECT h,concentrador_id,rbs_id,interface_id,kind,avg(value),max(value),min(value),count(*)
   FROM metric_samples WHERE source='snmp' AND collected_at>=h AND collected_at<h+interval '1 hour' GROUP BY 2,3,4,5
   ON CONFLICT DO NOTHING;
  h := h+interval '1 hour'; n_hours:=n_hours+1;
 END LOOP;
 INSERT INTO metric_daily SELECT date_trunc('day',bucket_at),concentrador_id,rbs_id,interface_id,kind,
   sum(avg_value*samples)/sum(samples),max(max_value),min(min_value),sum(samples)
  FROM metric_hourly WHERE bucket_at < date_trunc('day',now()) AND bucket_at >= coalesce((SELECT max(bucket_at)+interval '1 day' FROM metric_daily),'epoch')
  GROUP BY 1,2,3,4,5 ON CONFLICT DO NOTHING;
 -- só apaga brutos de horas já agregadas
 raw_cut := least(raw_cut, coalesce((SELECT max(bucket_at) FROM metric_hourly),'epoch'));
 LOOP DELETE FROM metric_samples WHERE id IN (SELECT id FROM metric_samples WHERE collected_at<raw_cut LIMIT 10000); GET DIAGNOSTICS n=ROW_COUNT; d_raw:=d_raw+n; EXIT WHEN n=0; END LOOP;
 LOOP DELETE FROM snmp_ingest_receipts WHERE ctid IN (SELECT ctid FROM snmp_ingest_receipts WHERE collected_at<now()-interval '3 days' LIMIT 5000); GET DIAGNOSTICS n=ROW_COUNT; d_rec:=d_rec+n; EXIT WHEN n=0; END LOOP;
 LOOP DELETE FROM eventos WHERE id IN (SELECT id FROM eventos WHERE created_at<now()-interval '90 days' LIMIT 5000); GET DIAGNOSTICS n=ROW_COUNT; d_ev:=d_ev+n; EXIT WHEN n=0; END LOOP;
 DELETE FROM notification_log WHERE created_at<now()-interval '90 days'; GET DIAGNOSTICS d_log=ROW_COUNT;
 DELETE FROM metric_hourly WHERE bucket_at<now()-interval '180 days'; GET DIAGNOSTICS d_h=ROW_COUNT;
 DELETE FROM metric_daily WHERE bucket_at<now()-interval '2 years'; GET DIAGNOSTICS d_d=ROW_COUNT;
 UPDATE maintenance_runs SET finished_at=now(), result=jsonb_build_object('hours_aggregated',n_hours,'raw_deleted',d_raw,'receipts_deleted',d_rec,'eventos_deleted',d_ev,'logs_deleted',d_log,'hourly_deleted',d_h,'daily_deleted',d_d) WHERE id=run_id;
 RETURN (SELECT result FROM maintenance_runs WHERE id=run_id);
END $$;
REVOKE EXECUTE ON FUNCTION public.metric_maintenance(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.metric_maintenance(int) TO service_role;

CREATE OR REPLACE FUNCTION public.metric_series(_concentrador uuid, _rbs uuid, _interface uuid, _kinds text[], _since timestamptz, _until timestamptz DEFAULT now(), _points integer DEFAULT 240)
RETURNS TABLE(bucket_at timestamptz, kind text, avg_value double precision, max_value double precision, samples bigint, bucket_seconds integer)
LANGUAGE sql STABLE SET search_path=public AS $$
  WITH p AS (SELECT GREATEST(30, ceil(extract(epoch FROM (_until-_since)) / LEAST(GREATEST(_points,10),1000)))::int AS sec),
  raw AS (
   SELECT to_timestamp(floor(extract(epoch FROM s.collected_at)/p.sec)*p.sec) b, s.kind::text k, avg(s.value) a, max(s.value) m, count(*) c, p.sec
   FROM metric_samples s, p
   WHERE p.sec < 3600 AND s.source='snmp' AND s.collected_at >= _since AND s.collected_at < _until AND s.kind::text = ANY(_kinds)
     AND (_concentrador IS NULL OR s.concentrador_id=_concentrador) AND (_rbs IS NULL OR s.rbs_id=_rbs)
     AND s.interface_id IS NOT DISTINCT FROM _interface
   GROUP BY 1,2,p.sec),
  agg AS (
   SELECT to_timestamp(floor(extract(epoch FROM h.bucket_at)/p.sec)*p.sec) b, h.kind::text k, sum(h.avg_value*h.samples)/sum(h.samples) a, max(h.max_value) m, sum(h.samples)::bigint c, p.sec
   FROM metric_hourly h, p
   WHERE p.sec >= 3600 AND h.bucket_at >= _since AND h.bucket_at < _until AND h.kind::text = ANY(_kinds)
     AND (_concentrador IS NULL OR h.concentrador_id=_concentrador) AND (_rbs IS NULL OR h.rbs_id=_rbs)
     AND h.interface_id IS NOT DISTINCT FROM _interface
   GROUP BY 1,2,p.sec)
  SELECT * FROM raw UNION ALL SELECT * FROM agg ORDER BY 1
$$;

SELECT cron.schedule('metric-maintenance-daily','0 6 * * *',$$SELECT public.metric_maintenance(400)$$);