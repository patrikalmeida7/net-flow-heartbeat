DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.persist_snmp_batch(uuid,timestamptz,jsonb)'::regprocedure) INTO definition;
 definition:=replace(definition,'INSERT INTO device_interfaces(concentrador_id,rbs_id,if_index,','INSERT INTO device_interfaces(id,concentrador_id,rbs_id,if_index,');
 definition:=replace(definition,'SELECT cid,rid,x.if_index,x.if_name','SELECT coalesce((old_interfaces->x.if_index::text->>''id'')::uuid,gen_random_uuid()),cid,rid,x.if_index,x.if_name');
 definition:=replace(definition,'ON CONFLICT(concentrador_id,if_index) DO UPDATE','ON CONFLICT(id) DO UPDATE');
 definition:=replace(definition,E'\n  WHERE cid IS NOT NULL;\n  -- RBS uses its own unique key; the first insert is restricted to concentradores below by the function definition adjustment.', ';');
 EXECUTE definition;
END $migration$;