-- Enum de status do provisionamento do cliente VPN
CREATE TYPE public.vpn_client_status AS ENUM (
  'pending',
  'provisioning',
  'active',
  'failed',
  'removed'
);

-- Tabela principal: fila + registro dos clientes VPN
CREATE TABLE public.vpn_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  nome text NOT NULL,
  internal_ip text NOT NULL,
  email text,
  observacoes text,
  status public.vpn_client_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  config_encrypted bytea,
  config_nonce bytea,
  config_sent_email_at timestamptz,
  provisioned_at timestamptz,
  removed_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vpn_clients_nome_agent_unique UNIQUE (agent_id, nome),
  CONSTRAINT vpn_clients_internal_ip_agent_unique UNIQUE (agent_id, internal_ip)
);

-- Validação extra: nome só com letras/números/hífen/underscore (evita injeção em shell)
ALTER TABLE public.vpn_clients
  ADD CONSTRAINT vpn_clients_nome_format CHECK (nome ~ '^[a-zA-Z0-9_-]{2,64}$');

-- Validação de IP simples (4 octetos)
ALTER TABLE public.vpn_clients
  ADD CONSTRAINT vpn_clients_ip_format CHECK (
    internal_ip ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
  );

CREATE INDEX vpn_clients_agent_status_idx ON public.vpn_clients (agent_id, status);
CREATE INDEX vpn_clients_status_idx ON public.vpn_clients (status);

-- Trigger updated_at
CREATE TRIGGER set_vpn_clients_updated_at
  BEFORE UPDATE ON public.vpn_clients
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.vpn_clients ENABLE ROW LEVEL SECURITY;

-- Apenas admin pode tudo via cliente authenticated. Service role (edge function) ignora RLS.
CREATE POLICY admins_manage_vpn_clients
  ON public.vpn_clients
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Funções de criptografia para o .conf gerado (mesmo padrão das outras secrets)
CREATE OR REPLACE FUNCTION public.set_vpn_client_config(_client_id uuid, _config text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgsodium
AS $$
DECLARE
  v_key bytea;
  v_nonce bytea;
  v_cipher bytea;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  v_key := pgsodium.crypto_generichash(_client_id::text::bytea, 'vpn_client_v1'::bytea, 32);
  v_nonce := pgsodium.randombytes_buf(24);
  v_cipher := pgsodium.crypto_secretbox(_config::bytea, v_nonce, v_key);

  UPDATE public.vpn_clients
     SET config_encrypted = v_cipher,
         config_nonce = v_nonce,
         updated_at = now()
   WHERE id = _client_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_vpn_client_config(_client_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgsodium
AS $$
DECLARE
  v_row public.vpn_clients%ROWTYPE;
  v_key bytea;
  v_plain bytea;
BEGIN
  IF auth.role() <> 'service_role' AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_row FROM public.vpn_clients WHERE id = _client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vpn client not found';
  END IF;

  IF v_row.config_encrypted IS NULL OR v_row.config_nonce IS NULL THEN
    RETURN NULL;
  END IF;

  v_key := pgsodium.crypto_generichash(v_row.id::text::bytea, 'vpn_client_v1'::bytea, 32);
  v_plain := pgsodium.crypto_secretbox_open(v_row.config_encrypted, v_row.config_nonce, v_key);
  RETURN convert_from(v_plain, 'UTF8');
END;
$$;

-- Realtime para a UI ver status mudando ao vivo
ALTER PUBLICATION supabase_realtime ADD TABLE public.vpn_clients;