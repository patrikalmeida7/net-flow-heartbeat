ALTER TABLE public.concentradores ADD COLUMN IF NOT EXISTS offline_since timestamptz;
ALTER TABLE public.concentradores ADD COLUMN IF NOT EXISTS last_collect_error text;
ALTER TABLE public.concentradores ADD COLUMN IF NOT EXISTS last_collect_attempt_at timestamptz;
COMMENT ON COLUMN public.concentradores.ultima_coleta IS 'Última coleta VÁLIDA via API RouterOS (não é renovada em falhas)';

CREATE INDEX IF NOT EXISTS pppoe_sessions_conc_user_idx ON public.pppoe_sessions (concentrador_id, username, ultima_atualizacao DESC);
CREATE INDEX IF NOT EXISTS eventos_tipo_created_idx ON public.eventos (tipo, created_at DESC);
CREATE INDEX IF NOT EXISTS eventos_conc_user_idx ON public.eventos (concentrador_id, username, created_at DESC);

CREATE TABLE public.notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  rule_key text,
  phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','delivered','failed')),
  attempts integer NOT NULL DEFAULT 0,
  provider_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dedupe_key, phone)
);
GRANT SELECT ON public.notification_deliveries TO authenticated;
GRANT ALL ON public.notification_deliveries TO service_role;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read deliveries" ON public.notification_deliveries FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_notif_deliveries_updated BEFORE UPDATE ON public.notification_deliveries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.job_locks (
  name text PRIMARY KEY,
  locked_until timestamptz NOT NULL DEFAULT 'epoch',
  holder text
);
GRANT ALL ON public.job_locks TO service_role;
ALTER TABLE public.job_locks ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.try_job_lock(_name text, _holder text, _seconds integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE ok boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  INSERT INTO job_locks(name) VALUES (_name) ON CONFLICT DO NOTHING;
  UPDATE job_locks SET locked_until = now() + make_interval(secs => _seconds), holder = _holder
   WHERE name = _name AND locked_until < now()
  RETURNING true INTO ok;
  RETURN coalesce(ok, false);
END $$;
CREATE OR REPLACE FUNCTION public.release_job_lock(_name text, _holder text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE job_locks SET locked_until = 'epoch' WHERE name = _name AND holder = _holder AND auth.role() = 'service_role';
$$;
REVOKE ALL ON FUNCTION public.try_job_lock(text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_job_lock(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_job_lock(text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_job_lock(text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.inet_or_null(_t text) RETURNS inet LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
BEGIN RETURN _t::inet; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'online_now', (SELECT count(*) FROM pppoe_sessions WHERE online AND ultima_atualizacao >= now() - interval '5 minutes'),
    'online_stale', (SELECT count(*) FROM pppoe_sessions WHERE online AND ultima_atualizacao < now() - interval '5 minutes'),
    'last_session_update', (SELECT max(ultima_atualizacao) FROM pppoe_sessions WHERE online),
    'disconnected_24h_clients', (SELECT count(DISTINCT (concentrador_id, username)) FROM eventos WHERE tipo='disconnect' AND created_at >= now() - interval '24 hours'),
    'individual_drops_24h', (SELECT count(*) FROM eventos WHERE tipo='disconnect' AND created_at >= now() - interval '24 hours'),
    'mass_incidents_24h', (SELECT count(*) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND created_at >= now() - interval '24 hours'),
    'mass_affected_24h', (SELECT coalesce(sum((metadata->>'count')::int),0) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND created_at >= now() - interval '24 hours'),
    'last_collect_at', (SELECT max(ultima_coleta) FROM concentradores),
    'last_agent_seen_at', (SELECT max(last_seen_at) FROM agents WHERE enabled)
  )
$$;

CREATE OR REPLACE FUNCTION public.pppoe_clients_page(
  _search text DEFAULT NULL, _status text DEFAULT 'all', _sort text DEFAULT 'drops', _dir text DEFAULT 'desc',
  _limit integer DEFAULT 50, _offset integer DEFAULT 0)
RETURNS TABLE(id uuid, concentrador_id uuid, concentrador_nome text, username text, ip_address text, interface text,
  uptime_seconds bigint, bytes_in bigint, bytes_out bigint, online boolean, stale boolean, conectado_em timestamptz,
  ultima_atualizacao timestamptz, drops_24h bigint, total_count bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH latest AS (
    SELECT DISTINCT ON (s.concentrador_id, s.username) s.*
    FROM pppoe_sessions s
    ORDER BY s.concentrador_id, s.username, s.ultima_atualizacao DESC
  ), d AS (
    SELECT e.concentrador_id, e.username, count(*) n FROM eventos e
    WHERE e.tipo='disconnect' AND e.created_at >= now() - interval '24 hours' GROUP BY 1,2
  ), f AS (
    SELECT l.*, c.nome AS cnome, coalesce(d.n,0) AS dn,
      (l.online AND l.ultima_atualizacao < now() - interval '5 minutes') AS is_stale
    FROM latest l
    LEFT JOIN concentradores c ON c.id = l.concentrador_id
    LEFT JOIN d ON d.concentrador_id IS NOT DISTINCT FROM l.concentrador_id AND d.username = l.username
    WHERE (_search IS NULL OR _search = '' OR l.username ILIKE '%'||_search||'%' OR l.ip_address ILIKE '%'||_search||'%')
      AND (_status = 'all' OR (_status='online' AND l.online) OR (_status='offline' AND NOT l.online))
  )
  SELECT f.id, f.concentrador_id, f.cnome, f.username, f.ip_address, f.interface, f.uptime_seconds, f.bytes_in, f.bytes_out,
    f.online, f.is_stale, f.conectado_em, f.ultima_atualizacao, f.dn, count(*) OVER ()
  FROM f
  ORDER BY
    CASE WHEN _dir='asc' AND _sort='username' THEN f.username END ASC,
    CASE WHEN _dir='desc' AND _sort='username' THEN f.username END DESC,
    CASE WHEN _dir='asc' AND _sort='ip' THEN public.inet_or_null(f.ip_address) END ASC,
    CASE WHEN _dir='desc' AND _sort='ip' THEN public.inet_or_null(f.ip_address) END DESC,
    CASE WHEN _dir='asc' AND _sort='uptime' THEN f.uptime_seconds END ASC NULLS FIRST,
    CASE WHEN _dir='desc' AND _sort='uptime' THEN f.uptime_seconds END DESC NULLS LAST,
    CASE WHEN _dir='asc' AND _sort='drops' THEN f.dn END ASC,
    CASE WHEN _dir='desc' AND _sort='drops' THEN f.dn END DESC,
    CASE WHEN _dir='asc' AND _sort='traffic' THEN coalesce(f.bytes_in,0)+coalesce(f.bytes_out,0) END ASC,
    CASE WHEN _dir='desc' AND _sort='traffic' THEN coalesce(f.bytes_in,0)+coalesce(f.bytes_out,0) END DESC,
    f.username, f.concentrador_id
  LIMIT LEAST(GREATEST(_limit,1),200) OFFSET GREATEST(_offset,0)
$$;

CREATE OR REPLACE FUNCTION public.pppoe_summary()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'clients', (SELECT count(DISTINCT (concentrador_id, username)) FROM pppoe_sessions),
    'session_records', (SELECT count(*) FROM pppoe_sessions),
    'online_fresh', (SELECT count(*) FROM pppoe_sessions WHERE online AND ultima_atualizacao >= now() - interval '5 minutes'),
    'online_stale', (SELECT count(*) FROM pppoe_sessions WHERE online AND ultima_atualizacao < now() - interval '5 minutes')
  )
$$;

CREATE OR REPLACE FUNCTION public.eventos_page(_tipo text DEFAULT NULL, _search text DEFAULT NULL,
  _concentrador uuid DEFAULT NULL, _username text DEFAULT NULL, _since timestamptz DEFAULT NULL,
  _limit integer DEFAULT 50, _offset integer DEFAULT 0)
RETURNS TABLE(id uuid, tipo event_type, concentrador_id uuid, concentrador_nome text, rbs_id uuid, username text,
  descricao text, metadata jsonb, created_at timestamptz, total_count bigint)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT e.id, e.tipo, e.concentrador_id, c.nome, e.rbs_id, e.username, e.descricao, e.metadata, e.created_at, count(*) OVER ()
  FROM eventos e LEFT JOIN concentradores c ON c.id = e.concentrador_id
  WHERE (_tipo IS NULL OR _tipo = '' OR
         (_tipo = 'mass' AND e.tipo='device_down' AND e.metadata->>'scope'='mass') OR
         (_tipo <> 'mass' AND e.tipo::text = _tipo))
    AND (_search IS NULL OR _search = '' OR e.username ILIKE '%'||_search||'%' OR e.descricao ILIKE '%'||_search||'%')
    AND (_concentrador IS NULL OR e.concentrador_id = _concentrador)
    AND (_username IS NULL OR e.username = _username
         OR (e.tipo='device_down' AND e.metadata->'usernames' ? _username))
    AND (_since IS NULL OR e.created_at >= _since)
  ORDER BY e.created_at DESC, e.id
  LIMIT LEAST(GREATEST(_limit,1),200) OFFSET GREATEST(_offset,0)
$$;

CREATE OR REPLACE FUNCTION public.client_drop_stats(_concentrador uuid, _username text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'individual_24h', (SELECT count(*) FROM eventos WHERE tipo='disconnect' AND concentrador_id = _concentrador AND username=_username AND created_at >= now()-interval '24 hours'),
    'individual_7d', (SELECT count(*) FROM eventos WHERE tipo='disconnect' AND concentrador_id = _concentrador AND username=_username AND created_at >= now()-interval '7 days'),
    'mass_7d', (SELECT count(*) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND concentrador_id=_concentrador AND metadata->'usernames' ? _username AND created_at >= now()-interval '7 days'),
    'sessions', (SELECT count(*) FROM pppoe_sessions WHERE concentrador_id=_concentrador AND username=_username)
  )
$$;

CREATE OR REPLACE FUNCTION public.analise_24h()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  WITH ev AS (SELECT * FROM eventos WHERE tipo='disconnect' AND created_at >= now()-interval '24 hours'),
  byu AS (SELECT concentrador_id, username, count(*) n FROM ev GROUP BY 1,2)
  SELECT jsonb_build_object(
    'individual_drops', (SELECT count(*) FROM ev),
    'mass_incidents', (SELECT count(*) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND created_at >= now()-interval '24 hours'),
    'mass_affected', (SELECT coalesce(sum((metadata->>'count')::int),0) FROM eventos WHERE tipo='device_down' AND metadata->>'scope'='mass' AND created_at >= now()-interval '24 hours'),
    'unstable', (SELECT count(*) FROM byu WHERE n >= 3),
    'by_hour', (SELECT coalesce(jsonb_agg(jsonb_build_object('h', h, 'n', n) ORDER BY h),'[]') FROM (SELECT date_trunc('hour', created_at) h, count(*) n FROM ev GROUP BY 1) x),
    'top', (SELECT coalesce(jsonb_agg(jsonb_build_object('concentrador_id', concentrador_id, 'username', username, 'n', n)),'[]') FROM (SELECT * FROM byu ORDER BY n DESC, username LIMIT 10) t)
  )
$$;

GRANT EXECUTE ON FUNCTION public.pppoe_clients_page(text,text,text,text,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pppoe_summary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.eventos_page(text,text,uuid,text,timestamptz,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.client_drop_stats(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.analise_24h() TO authenticated;
GRANT EXECUTE ON FUNCTION public.inet_or_null(text) TO authenticated;