DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='device_interfaces' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%if_index%' LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', r.indexname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX device_interfaces_conc_ifidx_uq ON public.device_interfaces(concentrador_id, if_index);
CREATE UNIQUE INDEX device_interfaces_rbs_ifidx_uq ON public.device_interfaces(rbs_id, if_index);