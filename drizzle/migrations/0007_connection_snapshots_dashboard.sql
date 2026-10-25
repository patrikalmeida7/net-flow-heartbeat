CREATE TABLE public.connection_snapshots (
  id bigserial PRIMARY KEY,
  concentrador_id uuid NOT NULL REFERENCES public.concentradores(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES public.organizations(id),
  bucket_at timestamptz NOT NULL,
  online_count integer NOT NULL,
  UNIQUE (concentrador_id, bucket_at)
);
GRANT SELECT ON public.connection_snapshots TO authenticated;
GRANT ALL ON public.connection_snapshots TO service_role;
GRANT USAGE ON SEQUENCE public.connection_snapshots_id_seq TO service_role;
ALTER TABLE public.connection_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read snapshots" ON public.connection_snapshots FOR SELECT TO authenticated USING (true);
CREATE INDEX connection_snapshots_bucket_idx ON public.connection_snapshots (bucket_at);

CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'online_now', (SELECT count(*) FROM pppoe_sessions WHERE online),
    'disconnected_24h_clients', (SELECT count(DISTINCT username) FROM eventos WHERE tipo='disconnect' AND created_at >= now() - interval '24 hours'),
    'mass_incidents_24h', (SELECT count(*) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND created_at >= now() - interval '24 hours'),
    'last_collect_at', (SELECT max(ultima_coleta) FROM concentradores),
    'last_agent_seen_at', (SELECT max(last_seen_at) FROM agents WHERE enabled)
  )
$$;
GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated;

CREATE OR REPLACE FUNCTION public.connection_history(_hours integer DEFAULT 24)
RETURNS TABLE(bucket_at timestamptz, online bigint) LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT bucket_at, sum(online_count)::bigint FROM connection_snapshots
  WHERE bucket_at >= now() - make_interval(hours => LEAST(GREATEST(_hours,1),720))
  GROUP BY bucket_at ORDER BY bucket_at
$$;
GRANT EXECUTE ON FUNCTION public.connection_history(integer) TO authenticated;