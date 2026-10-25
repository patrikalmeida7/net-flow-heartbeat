DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.persist_snmp_batch(uuid,timestamptz,jsonb)'::regprocedure) INTO definition;
 definition:=replace(definition,'status=CASE WHEN $3 THEN ''online'' ELSE ''unknown'' END,ultima_coleta','status=(CASE WHEN $3 THEN ''online'' ELSE ''unknown'' END)::public.device_status,ultima_coleta');
 EXECUTE definition;
END $migration$;