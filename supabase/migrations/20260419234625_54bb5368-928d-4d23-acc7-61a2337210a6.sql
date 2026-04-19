-- Enums
CREATE TYPE public.vpn_protocol AS ENUM ('wireguard', 'openvpn');
CREATE TYPE public.vpn_desired_state AS ENUM ('up', 'down');

-- Agentes que rodam na infra do cliente
CREATE TABLE public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  descricao text,
  token_hash text NOT NULL UNIQUE, -- sha256 do token bearer
  enabled boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz,
  last_ip text,
  version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY admins_manage_agents ON public.agents
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY auth_view_agents ON public.agents
  FOR SELECT TO authenticated
  USING (true);

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Conexões VPN
CREATE TABLE public.vpn_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  protocol public.vpn_protocol NOT NULL,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  endpoint_host text NOT NULL,
  endpoint_port integer NOT NULL,
  -- WireGuard
  wg_private_key_encrypted bytea,
  wg_private_key_nonce bytea,
  wg_peer_public_key text,
  wg_preshared_key_encrypted bytea,
  wg_preshared_key_nonce bytea,
  wg_address_cidr text, -- ex: 10.10.0.2/24
  wg_allowed_ips text,  -- ex: 10.10.0.0/24,192.168.88.0/24
  wg_dns text,
  wg_persistent_keepalive integer DEFAULT 25,
  -- OpenVPN
  ovpn_config_encrypted bytea,
  ovpn_config_nonce bytea,
  ovpn_username text,
  ovpn_password_encrypted bytea,
  ovpn_password_nonce bytea,
  -- Comum
  grupo text,
  desired_state public.vpn_desired_state NOT NULL DEFAULT 'up',
  enabled boolean NOT NULL DEFAULT true,
  observacoes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vpn_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY admins_manage_vpn_connections ON public.vpn_connections
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY auth_view_vpn_connections ON public.vpn_connections
  FOR SELECT TO authenticated
  USING (true);

CREATE TRIGGER trg_vpn_connections_updated_at
  BEFORE UPDATE ON public.vpn_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX idx_vpn_connections_agent ON public.vpn_connections(agent_id);
CREATE INDEX idx_vpn_connections_grupo ON public.vpn_connections(grupo);

-- Status atual (1 linha por conexão, upsert pelo agente)
CREATE TABLE public.vpn_status (
  vpn_connection_id uuid PRIMARY KEY REFERENCES public.vpn_connections(id) ON DELETE CASCADE,
  online boolean NOT NULL DEFAULT false,
  latency_ms integer,
  last_handshake_at timestamptz,
  rx_bytes bigint DEFAULT 0,
  tx_bytes bigint DEFAULT 0,
  internal_ip text,
  uptime_seconds bigint,
  last_error text,
  reported_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vpn_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_view_vpn_status ON public.vpn_status
  FOR SELECT TO authenticated
  USING (true);

-- (sem policies de write — só service_role escreve via edge function)

-- Histórico de eventos
CREATE TABLE public.vpn_events (
  id bigserial PRIMARY KEY,
  vpn_connection_id uuid NOT NULL REFERENCES public.vpn_connections(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('connect','disconnect','error','reconnect','config_applied')),
  message text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vpn_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_view_vpn_events ON public.vpn_events
  FOR SELECT TO authenticated
  USING (true);

CREATE INDEX idx_vpn_events_conn_time ON public.vpn_events(vpn_connection_id, created_at DESC);

-- Vincular concentradores e RBS a uma VPN (acesso via IP interno)
ALTER TABLE public.concentradores
  ADD COLUMN vpn_connection_id uuid REFERENCES public.vpn_connections(id) ON DELETE SET NULL,
  ADD COLUMN host_interno text;

ALTER TABLE public.rbs
  ADD COLUMN vpn_connection_id uuid REFERENCES public.vpn_connections(id) ON DELETE SET NULL,
  ADD COLUMN host_interno text;

-- Funções de criptografia (mesmo padrão de device_credentials)
CREATE OR REPLACE FUNCTION public.set_vpn_secret(
  _connection_id uuid,
  _field text,
  _value text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgsodium
AS $$
DECLARE
  v_key bytea;
  v_nonce bytea;
  v_cipher bytea;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF _field NOT IN ('wg_private_key','wg_preshared_key','ovpn_config','ovpn_password') THEN
    RAISE EXCEPTION 'invalid field: %', _field;
  END IF;

  v_key := pgsodium.crypto_generichash(_connection_id::text::bytea, 'vpn_creds_v1'::bytea, 32);
  v_nonce := pgsodium.randombytes_buf(24);
  v_cipher := pgsodium.crypto_secretbox(_value::bytea, v_nonce, v_key);

  EXECUTE format(
    'UPDATE public.vpn_connections SET %I = $1, %I = $2, updated_at = now() WHERE id = $3',
    _field || '_encrypted',
    _field || '_nonce'
  ) USING v_cipher, v_nonce, _connection_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_vpn_secret(
  _connection_id uuid,
  _field text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgsodium
AS $$
DECLARE
  v_cipher bytea;
  v_nonce bytea;
  v_key bytea;
  v_plain bytea;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF _field NOT IN ('wg_private_key','wg_preshared_key','ovpn_config','ovpn_password') THEN
    RAISE EXCEPTION 'invalid field: %', _field;
  END IF;

  EXECUTE format(
    'SELECT %I, %I FROM public.vpn_connections WHERE id = $1',
    _field || '_encrypted',
    _field || '_nonce'
  ) INTO v_cipher, v_nonce USING _connection_id;

  IF v_cipher IS NULL OR v_nonce IS NULL THEN
    RETURN NULL;
  END IF;

  v_key := pgsodium.crypto_generichash(_connection_id::text::bytea, 'vpn_creds_v1'::bytea, 32);
  v_plain := pgsodium.crypto_secretbox_open(v_cipher, v_nonce, v_key);
  RETURN convert_from(v_plain, 'UTF8');
END;
$$;

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.vpn_status;
ALTER PUBLICATION supabase_realtime ADD TABLE public.vpn_events;