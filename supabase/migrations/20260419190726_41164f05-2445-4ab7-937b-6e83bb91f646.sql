-- Habilita pgsodium para criptografia em repouso
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- Enum de protocolo
DO $$ BEGIN
  CREATE TYPE public.remote_protocol AS ENUM ('ssh', 'telnet');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tabela de credenciais
CREATE TABLE public.device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concentrador_id uuid REFERENCES public.concentradores(id) ON DELETE CASCADE,
  rbs_id uuid REFERENCES public.rbs(id) ON DELETE CASCADE,
  protocol public.remote_protocol NOT NULL DEFAULT 'ssh',
  host text NOT NULL,
  port integer NOT NULL DEFAULT 22,
  username text NOT NULL,
  password_encrypted bytea NOT NULL,
  password_nonce bytea NOT NULL,
  observacoes text,
  enabled boolean NOT NULL DEFAULT true,
  last_poll_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_credentials_one_target CHECK (
    (concentrador_id IS NOT NULL AND rbs_id IS NULL) OR
    (concentrador_id IS NULL AND rbs_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX device_credentials_concentrador_uniq
  ON public.device_credentials(concentrador_id) WHERE concentrador_id IS NOT NULL;
CREATE UNIQUE INDEX device_credentials_rbs_uniq
  ON public.device_credentials(rbs_id) WHERE rbs_id IS NOT NULL;

CREATE TRIGGER device_credentials_set_updated_at
  BEFORE UPDATE ON public.device_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.device_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_manage_device_credentials"
  ON public.device_credentials
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Função para gravar senha criptografada (admin only).
-- Gera nonce aleatório e cifra com pgsodium usando chave derivada do server_secret.
CREATE OR REPLACE FUNCTION public.set_device_credential_password(
  _credential_id uuid,
  _password text
)
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
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- Chave determinística derivada (32 bytes) — usa o id da credencial como contexto
  v_key := pgsodium.crypto_generichash(_credential_id::text::bytea, 'device_creds_v1'::bytea, 32);
  v_nonce := pgsodium.randombytes_buf(24);
  v_cipher := pgsodium.crypto_secretbox(_password::bytea, v_nonce, v_key);

  UPDATE public.device_credentials
     SET password_encrypted = v_cipher,
         password_nonce = v_nonce,
         updated_at = now()
   WHERE id = _credential_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_device_credential_password(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_device_credential_password(uuid, text) TO authenticated;

-- Função para ler a senha em texto puro — usada SOMENTE pela edge function via service role.
-- Bloqueia acesso de usuários comuns; só roles privilegiadas (service_role) ou admins.
CREATE OR REPLACE FUNCTION public.get_device_credential_password(_credential_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgsodium
AS $$
DECLARE
  v_row public.device_credentials%ROWTYPE;
  v_key bytea;
  v_plain bytea;
BEGIN
  -- Permitir apenas service_role (edge function) ou admin autenticado
  IF auth.role() <> 'service_role' AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT * INTO v_row FROM public.device_credentials WHERE id = _credential_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credential not found';
  END IF;

  v_key := pgsodium.crypto_generichash(v_row.id::text::bytea, 'device_creds_v1'::bytea, 32);
  v_plain := pgsodium.crypto_secretbox_open(v_row.password_encrypted, v_row.password_nonce, v_key);
  RETURN convert_from(v_plain, 'UTF8');
END;
$$;

REVOKE ALL ON FUNCTION public.get_device_credential_password(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_device_credential_password(uuid) TO authenticated, service_role;

-- Tabela de resultados de coleta SSH (para histórico curto na UI)
CREATE TABLE public.device_ssh_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id uuid NOT NULL REFERENCES public.device_credentials(id) ON DELETE CASCADE,
  concentrador_id uuid REFERENCES public.concentradores(id) ON DELETE CASCADE,
  rbs_id uuid REFERENCES public.rbs(id) ON DELETE CASCADE,
  collected_at timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL,
  error text,
  results jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms integer
);

CREATE INDEX device_ssh_polls_cred_recent
  ON public.device_ssh_polls(credential_id, collected_at DESC);

ALTER TABLE public.device_ssh_polls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_view_ssh_polls"
  ON public.device_ssh_polls
  FOR SELECT
  TO authenticated
  USING (true);
-- INSERT só via service_role (edge function); sem policy de insert para usuários.