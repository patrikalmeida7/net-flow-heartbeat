ALTER TABLE public.device_interfaces ADD COLUMN IF NOT EXISTS in_counter_bits integer, ADD COLUMN IF NOT EXISTS out_counter_bits integer;
ALTER TABLE public.concentradores ADD COLUMN IF NOT EXISTS snmp_persisted_at timestamptz, ADD COLUMN IF NOT EXISTS snmp_persistence_error text;
ALTER TABLE public.rbs ADD COLUMN IF NOT EXISTS snmp_persisted_at timestamptz, ADD COLUMN IF NOT EXISTS snmp_persistence_error text;
CREATE TABLE public.snmp_ingest_receipts (target_id uuid NOT NULL, collected_at timestamptz NOT NULL, payload jsonb NOT NULL, result jsonb NOT NULL, PRIMARY KEY(target_id,collected_at));
GRANT ALL ON public.snmp_ingest_receipts TO service_role;
ALTER TABLE public.snmp_ingest_receipts ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.persist_snmp_batch(_agent uuid, _at timestamptz, _dev jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cid uuid:=(_dev->>'concentrador_id')::uuid; rid uuid:=(_dev->>'rbs_id')::uuid; tid uuid:=coalesce(cid,rid); tab text; prev jsonb; old_interfaces jsonb; receipt record; valid boolean; err text; offline_at timestamptz; n_interfaces integer:=0; n_samples integer:=0; result jsonb; org uuid; device_org uuid; rows jsonb:=coalesce(_dev->'interfaces','[]'::jsonb);
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
 IF (cid IS NULL)=(rid IS NULL) OR tid IS NULL THEN RAISE EXCEPTION 'Exactly one device required'; END IF;
 tab:=CASE WHEN cid IS NOT NULL THEN 'concentradores' ELSE 'rbs' END;
 PERFORM pg_advisory_xact_lock(hashtextextended('snmp:'||tid::text,0));
 EXECUTE format('SELECT to_jsonb(d) FROM public.%I d WHERE id=$1 FOR UPDATE',tab) INTO prev USING tid;
 IF prev IS NULL THEN RAISE EXCEPTION 'Unknown device'; END IF;
 IF _agent IS NOT NULL THEN
  SELECT organization_id INTO org FROM agents WHERE id=_agent AND enabled;
  IF NOT FOUND THEN RAISE EXCEPTION 'Disabled agent'; END IF;
  device_org:=(prev->>'organization_id')::uuid;
  IF device_org IS DISTINCT FROM org OR NOT EXISTS(SELECT 1 FROM snmp_credentials WHERE agent_id=_agent AND enabled AND organization_id IS NOT DISTINCT FROM org AND concentrador_id IS NOT DISTINCT FROM cid AND rbs_id IS NOT DISTINCT FROM rid) THEN RAISE EXCEPTION 'Agent/device organization mismatch'; END IF;
 END IF;
 SELECT * INTO receipt FROM snmp_ingest_receipts WHERE target_id=tid AND collected_at=_at;
 IF FOUND THEN
  IF receipt.payload IS DISTINCT FROM _dev THEN RAISE EXCEPTION 'Conflicting payload for same timestamp'; END IF;
  RETURN receipt.result||jsonb_build_object('duplicate',true,'samples_inserted',0,'interfaces_upserted',0);
 END IF;
 IF abs(extract(epoch FROM (clock_timestamp()-_at)))>120 THEN RAISE EXCEPTION 'Stale collected_at'; END IF;
 IF _at < (prev->>'snmp_last_attempt_at')::timestamptz OR _at <= (prev->>'snmp_persisted_at')::timestamptz THEN RETURN jsonb_build_object('ok',true,'persistence_complete',true,'ignored_out_of_order',true,'samples_inserted',0,'interfaces_upserted',0); END IF;
 valid:=coalesce((_dev->>'snmp_valid')::boolean,false) AND nullif(_dev->>'snmp_error','') IS NULL AND (_dev->>'uptime_seconds') IS NOT NULL;
 err:=CASE WHEN valid THEN NULL ELSE coalesce(_dev->>'snmp_error','SNMP sem resposta de sistema válida') END;
 offline_at:=CASE WHEN valid THEN NULL WHEN prev->>'snmp_status'='unreachable' THEN coalesce((prev->>'offline_since')::timestamptz,_at) ELSE _at END;
 IF valid THEN
  SELECT coalesce(jsonb_object_agg(if_index::text,to_jsonb(i)),'{}'::jsonb) INTO old_interfaces FROM device_interfaces i WHERE concentrador_id IS NOT DISTINCT FROM cid AND rbs_id IS NOT DISTINCT FROM rid;
  INSERT INTO device_interfaces(concentrador_id,rbs_id,if_index,if_name,if_descr,if_alias,if_speed_bps,oper_status,admin_status,last_in_octets,last_out_octets,last_sample_at,counter_source,last_device_uptime,in_counter_bits,out_counter_bits)
  SELECT cid,rid,x.if_index,x.if_name,x.if_descr,x.if_alias,x.if_speed_bps,x.oper_status,x.admin_status,x.in_octets,x.out_octets,_at,'snmp',(_dev->>'uptime_seconds')::bigint,x.in_counter_bits,x.out_counter_bits FROM jsonb_to_recordset(rows) AS x(if_index integer,if_name text,if_descr text,if_alias text,if_speed_bps bigint,oper_status text,admin_status text,in_octets bigint,out_octets bigint,in_counter_bits integer,out_counter_bits integer)
  ON CONFLICT(concentrador_id,if_index) DO UPDATE SET if_name=EXCLUDED.if_name,if_descr=EXCLUDED.if_descr,if_alias=EXCLUDED.if_alias,if_speed_bps=EXCLUDED.if_speed_bps,oper_status=EXCLUDED.oper_status,admin_status=EXCLUDED.admin_status,last_in_octets=EXCLUDED.last_in_octets,last_out_octets=EXCLUDED.last_out_octets,last_sample_at=EXCLUDED.last_sample_at,counter_source=EXCLUDED.counter_source,last_device_uptime=EXCLUDED.last_device_uptime,in_counter_bits=EXCLUDED.in_counter_bits,out_counter_bits=EXCLUDED.out_counter_bits
  WHERE cid IS NOT NULL;
  -- RBS uses its own unique key; the first insert is restricted to concentradores below by the function definition adjustment.
  GET DIAGNOSTICS n_interfaces=ROW_COUNT;
  WITH input AS (SELECT x.*,old_interfaces->x.if_index::text AS p FROM jsonb_to_recordset(rows) AS x(if_index integer,oper_status text,in_octets bigint,out_octets bigint,in_errors bigint,out_errors bigint,in_counter_bits integer,out_counter_bits integer)),
  iface_metrics AS (
   SELECT i.id AS interface_id,v.kind,v.value FROM input x JOIN device_interfaces i ON i.concentrador_id IS NOT DISTINCT FROM cid AND i.rbs_id IS NOT DISTINCT FROM rid AND i.if_index=x.if_index
   CROSS JOIN LATERAL (SELECT extract(epoch FROM (_at-(x.p->>'last_sample_at')::timestamptz)) AS dt) t
   CROSS JOIN LATERAL (VALUES
    ('if_oper_status',CASE WHEN x.oper_status IS NULL THEN NULL ELSE CASE WHEN x.oper_status='up' THEN 1::double precision ELSE 0::double precision END END),
    ('if_in_errors',x.in_errors::double precision),('if_out_errors',x.out_errors::double precision),
    ('if_in_bps',CASE WHEN x.p->>'counter_source'='snmp' AND x.in_counter_bits=(x.p->>'in_counter_bits')::integer AND (_dev->>'uptime_seconds')::bigint >= (x.p->>'last_device_uptime')::bigint AND t.dt>0 AND t.dt<600 AND x.in_octets >= (x.p->>'last_in_octets')::bigint THEN (x.in_octets-(x.p->>'last_in_octets')::bigint)*8.0/t.dt END),
    ('if_out_bps',CASE WHEN x.p->>'counter_source'='snmp' AND x.out_counter_bits=(x.p->>'out_counter_bits')::integer AND (_dev->>'uptime_seconds')::bigint >= (x.p->>'last_device_uptime')::bigint AND t.dt>0 AND t.dt<600 AND x.out_octets >= (x.p->>'last_out_octets')::bigint THEN (x.out_octets-(x.p->>'last_out_octets')::bigint)*8.0/t.dt END)
   ) v(kind,value)
  ), globals AS (SELECT NULL::uuid AS interface_id,k AS kind,(_dev->>k)::double precision AS value FROM unnest(ARRAY['cpu_load','memory_used_pct','uptime_seconds','temperature_c','ping_ms','ping_loss_pct']) k), all_metrics AS (SELECT * FROM iface_metrics UNION ALL SELECT * FROM globals)
  INSERT INTO metric_samples(collected_at,concentrador_id,rbs_id,interface_id,kind,value,source)
  SELECT _at,cid,rid,m.interface_id,m.kind::metric_kind,m.value,'snmp' FROM all_metrics m WHERE m.value IS NOT NULL AND NOT EXISTS(SELECT 1 FROM metric_samples s WHERE s.collected_at=_at AND s.source='snmp' AND s.concentrador_id IS NOT DISTINCT FROM cid AND s.rbs_id IS NOT DISTINCT FROM rid AND s.interface_id IS NOT DISTINCT FROM m.interface_id AND s.kind=m.kind::metric_kind);
  GET DIAGNOSTICS n_samples=ROW_COUNT;
 END IF;
 EXECUTE format('UPDATE public.%I SET snmp_last_attempt_at=$2,snmp_last_success_at=CASE WHEN $3 THEN $2 ELSE snmp_last_success_at END,snmp_last_error=$4,snmp_status=CASE WHEN $3 THEN ''online'' ELSE ''unreachable'' END,status=CASE WHEN $3 THEN ''online'' ELSE ''unknown'' END,ultima_coleta=CASE WHEN $3 THEN $2 ELSE ultima_coleta END,snmp_persisted_at=$2,snmp_persistence_error=NULL WHERE id=$1',tab) USING tid,_at,valid,err;
 IF cid IS NOT NULL THEN
  UPDATE concentradores SET offline_since=offline_at,last_collect_attempt_at=_at,last_collect_error=err,cpu_load=CASE WHEN valid THEN (_dev->>'cpu_load')::double precision ELSE cpu_load END,memory_used_pct=CASE WHEN valid THEN (_dev->>'memory_used_pct')::double precision ELSE memory_used_pct END,uptime_seconds=CASE WHEN valid THEN (_dev->>'uptime_seconds')::bigint ELSE uptime_seconds END WHERE id=cid;
  IF (valid AND prev->>'snmp_status'='unreachable') OR (NOT valid AND prev->>'snmp_status'='online') THEN
   INSERT INTO eventos(tipo,concentrador_id,created_at,descricao,metadata) VALUES(CASE WHEN valid THEN 'device_up'::event_type ELSE 'device_down'::event_type END,cid,_at,CASE WHEN valid THEN 'Monitoramento SNMP recuperado' ELSE 'SNMP indisponível; equipamento desligado não confirmado' END,jsonb_build_object('source','snmp','scope','monitoring','offline_since',coalesce((prev->>'offline_since')::timestamptz,_at),'recovered_at',CASE WHEN valid THEN _at END));
  END IF;
 END IF;
 UPDATE snmp_credentials SET last_poll_at=_at,last_error=err WHERE concentrador_id IS NOT DISTINCT FROM cid AND rbs_id IS NOT DISTINCT FROM rid;
 result:=jsonb_build_object('ok',true,'persistence_complete',true,'snmp_valid',valid,'samples_inserted',n_samples,'interfaces_upserted',n_interfaces);
 INSERT INTO snmp_ingest_receipts VALUES(tid,_at,_dev,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.persist_snmp_batch(uuid,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.persist_snmp_batch(uuid,timestamptz,jsonb) TO service_role;