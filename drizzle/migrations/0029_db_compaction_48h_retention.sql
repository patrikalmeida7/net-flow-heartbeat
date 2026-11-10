CREATE OR REPLACE FUNCTION public.metric_maintenance(_max_hours integer DEFAULT 24)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' SET statement_timeout TO '0'
AS $function$
DECLARE h timestamptz; n_hours int:=0; d_raw bigint:=0; d_rec bigint:=0; d_ev bigint:=0; d_log bigint:=0; d_h bigint:=0; d_d bigint:=0; n bigint; run_id bigint;
 t0 timestamptz := clock_timestamp(); raw_cut timestamptz; slice timestamptz; oldest timestamptz;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' AND current_user NOT IN ('postgres','supabase_admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
 INSERT INTO maintenance_runs(job) VALUES('metric_maintenance') RETURNING id INTO run_id;
 -- 1) rollup horário incremental (poucas horas por execução)
 SELECT max(bucket_at)+interval '1 hour' INTO h FROM metric_hourly;
 IF h IS NULL THEN SELECT date_trunc('hour',min(collected_at)) INTO h FROM metric_samples; END IF;
 WHILE h IS NOT NULL AND h < date_trunc('hour',now()) AND n_hours < _max_hours AND clock_timestamp()-t0 < interval '3 minutes' LOOP
  INSERT INTO metric_hourly SELECT h,concentrador_id,rbs_id,interface_id,kind,avg(value),max(value),min(value),count(*)
   FROM metric_samples WHERE source='snmp' AND collected_at>=h AND collected_at<h+interval '1 hour' GROUP BY 2,3,4,5
   ON CONFLICT DO NOTHING;
  h := h+interval '1 hour'; n_hours:=n_hours+1;
 END LOOP;
 -- 2) rollup diário
 INSERT INTO metric_daily SELECT date_trunc('day',bucket_at),concentrador_id,rbs_id,interface_id,kind,
   sum(avg_value*samples)/sum(samples),max(max_value),min(min_value),sum(samples)
  FROM metric_hourly WHERE bucket_at < date_trunc('day',now()) AND bucket_at >= coalesce((SELECT max(bucket_at)+interval '1 day' FROM metric_daily),'epoch')
  GROUP BY 1,2,3,4,5 ON CONFLICT DO NOTHING;
 -- 3) brutos: 48h, somente horas já agregadas, apagando em fatias de 1h
 raw_cut := least(now()-interval '48 hours', coalesce((SELECT max(bucket_at) FROM metric_hourly),'epoch'));
 SELECT min(collected_at) INTO oldest FROM metric_samples;
 slice := date_trunc('hour', oldest);
 WHILE slice IS NOT NULL AND slice < raw_cut AND clock_timestamp()-t0 < interval '8 minutes' LOOP
  DELETE FROM metric_samples WHERE collected_at >= slice AND collected_at < least(slice+interval '1 hour', raw_cut);
  GET DIAGNOSTICS n=ROW_COUNT; d_raw:=d_raw+n; slice := slice+interval '1 hour';
 END LOOP;
 -- 4) recibos SNMP: só servem para retry idempotente (<120s)
 DELETE FROM snmp_ingest_receipts WHERE collected_at<now()-interval '2 hours'; GET DIAGNOSTICS d_rec=ROW_COUNT;
 LOOP DELETE FROM eventos WHERE id IN (SELECT id FROM eventos WHERE created_at<now()-interval '90 days' LIMIT 5000); GET DIAGNOSTICS n=ROW_COUNT; d_ev:=d_ev+n; EXIT WHEN n=0; END LOOP;
 DELETE FROM notification_log WHERE created_at<now()-interval '90 days'; GET DIAGNOSTICS d_log=ROW_COUNT;
 DELETE FROM metric_hourly WHERE bucket_at<now()-interval '180 days'; GET DIAGNOSTICS d_h=ROW_COUNT;
 DELETE FROM metric_daily WHERE bucket_at<now()-interval '2 years'; GET DIAGNOSTICS d_d=ROW_COUNT;
 DELETE FROM maintenance_runs WHERE started_at<now()-interval '30 days';
 UPDATE maintenance_runs SET finished_at=now(), result=jsonb_build_object('hours_aggregated',n_hours,'raw_deleted',d_raw,'receipts_deleted',d_rec,'eventos_deleted',d_ev,'logs_deleted',d_log,'hourly_deleted',d_h,'daily_deleted',d_d) WHERE id=run_id;
 RETURN (SELECT result FROM maintenance_runs WHERE id=run_id);
END $function$;

CREATE OR REPLACE FUNCTION public.metric_series(_concentrador uuid, _rbs uuid, _interface uuid, _kinds text[], _since timestamp with time zone, _until timestamp with time zone DEFAULT now(), _points integer DEFAULT 240)
 RETURNS TABLE(bucket_at timestamp with time zone, kind text, avg_value double precision, max_value double precision, samples bigint, bucket_seconds integer)
 LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  WITH p AS (SELECT CASE WHEN _since >= now()-interval '47 hours'
                      THEN GREATEST(30, ceil(extract(epoch FROM (_until-_since)) / LEAST(GREATEST(_points,10),1000)))::int
                      ELSE GREATEST(3600, ceil(extract(epoch FROM (_until-_since)) / LEAST(GREATEST(_points,10),1000)/3600)*3600)::int END AS sec),
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
$function$;

-- índice redundante: concentrador/rbs nunca filtram amostras de interface sem kind+tempo
DROP INDEX IF EXISTS public.metric_samples_rbs_time_idx;

SELECT cron.unschedule(2);
SELECT cron.unschedule(3);
SELECT cron.schedule('metric-maintenance-hourly', '7 * * * *', $$SELECT public.metric_maintenance(24)$$);
SELECT cron.schedule('cron-history-cleanup', '15 4 * * *', $$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '3 days'$$);