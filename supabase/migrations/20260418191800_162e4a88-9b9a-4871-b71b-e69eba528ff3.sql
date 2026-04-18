-- ============================================================
-- SNMP Monitoring: schema (Phase 1 vertical slice)
-- ============================================================

-- 1. Credenciais SNMP por dispositivo (concentrador OU rbs)
-- ------------------------------------------------------------
CREATE TYPE public.snmp_version AS ENUM ('v2c', 'v3');
CREATE TYPE public.snmp_auth_proto AS ENUM ('none', 'MD5', 'SHA');
CREATE TYPE public.snmp_priv_proto AS ENUM ('none', 'DES', 'AES');

CREATE TABLE public.snmp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concentrador_id uuid REFERENCES public.concentradores(id) ON DELETE CASCADE,
  rbs_id uuid REFERENCES public.rbs(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  version public.snmp_version NOT NULL DEFAULT 'v2c',
  port integer NOT NULL DEFAULT 161,
  -- v2c
  community text,
  -- v3
  username text,
  auth_proto public.snmp_auth_proto NOT NULL DEFAULT 'none',
  auth_password text,
  priv_proto public.snmp_priv_proto NOT NULL DEFAULT 'none',
  priv_password text,
  -- coleta
  poll_interval_seconds integer NOT NULL DEFAULT 30,
  timeout_ms integer NOT NULL DEFAULT 3000,
  retries integer NOT NULL DEFAULT 2,
  last_poll_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- exatamente um alvo
  CONSTRAINT snmp_one_target CHECK (
    (concentrador_id IS NOT NULL AND rbs_id IS NULL) OR
    (concentrador_id IS NULL AND rbs_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX snmp_creds_concentrador_uq
  ON public.snmp_credentials(concentrador_id) WHERE concentrador_id IS NOT NULL;
CREATE UNIQUE INDEX snmp_creds_rbs_uq
  ON public.snmp_credentials(rbs_id) WHERE rbs_id IS NOT NULL;

CREATE TRIGGER snmp_credentials_updated_at
  BEFORE UPDATE ON public.snmp_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.snmp_credentials ENABLE ROW LEVEL SECURITY;

-- Apenas admin gerencia/visualiza credenciais (contêm senhas)
CREATE POLICY admins_manage_snmp_creds ON public.snmp_credentials
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 2. Interfaces descobertas por SNMP (ifTable)
-- ------------------------------------------------------------
CREATE TABLE public.device_interfaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concentrador_id uuid REFERENCES public.concentradores(id) ON DELETE CASCADE,
  rbs_id uuid REFERENCES public.rbs(id) ON DELETE CASCADE,
  if_index integer NOT NULL,
  if_name text,
  if_descr text,
  if_alias text,
  if_speed_bps bigint,           -- ifHighSpeed * 1_000_000 ou ifSpeed
  oper_status text,              -- up, down, testing...
  admin_status text,
  last_in_octets numeric,        -- contador 64bit (ifHCInOctets)
  last_out_octets numeric,
  last_sample_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT iface_one_target CHECK (
    (concentrador_id IS NOT NULL AND rbs_id IS NULL) OR
    (concentrador_id IS NULL AND rbs_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX iface_concentrador_idx_uq
  ON public.device_interfaces(concentrador_id, if_index)
  WHERE concentrador_id IS NOT NULL;
CREATE UNIQUE INDEX iface_rbs_idx_uq
  ON public.device_interfaces(rbs_id, if_index)
  WHERE rbs_id IS NOT NULL;

CREATE TRIGGER device_interfaces_updated_at
  BEFORE UPDATE ON public.device_interfaces
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.device_interfaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_view_interfaces ON public.device_interfaces
  FOR SELECT TO authenticated USING (true);

CREATE POLICY admins_manage_interfaces ON public.device_interfaces
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 3. Amostras de métricas (time-series cru, retenção 7 dias)
-- ------------------------------------------------------------
CREATE TYPE public.metric_kind AS ENUM (
  'cpu_load',
  'memory_used_pct',
  'uptime_seconds',
  'temperature_c',
  'if_in_bps',         -- bits por segundo (calculado pela edge function via delta)
  'if_out_bps',
  'if_in_errors',
  'if_out_errors',
  'if_oper_status',    -- 1 up, 2 down
  'ping_ms',
  'ping_loss_pct'
);

CREATE TABLE public.metric_samples (
  id bigserial PRIMARY KEY,
  collected_at timestamptz NOT NULL DEFAULT now(),
  concentrador_id uuid REFERENCES public.concentradores(id) ON DELETE CASCADE,
  rbs_id uuid REFERENCES public.rbs(id) ON DELETE CASCADE,
  interface_id uuid REFERENCES public.device_interfaces(id) ON DELETE CASCADE,
  kind public.metric_kind NOT NULL,
  value double precision NOT NULL,
  CONSTRAINT sample_one_target CHECK (
    (concentrador_id IS NOT NULL AND rbs_id IS NULL) OR
    (concentrador_id IS NULL AND rbs_id IS NOT NULL)
  )
);

-- Índices para consultas típicas (últimos N min de uma interface/dispositivo)
CREATE INDEX metric_samples_iface_time_idx
  ON public.metric_samples(interface_id, kind, collected_at DESC)
  WHERE interface_id IS NOT NULL;
CREATE INDEX metric_samples_conc_time_idx
  ON public.metric_samples(concentrador_id, kind, collected_at DESC)
  WHERE concentrador_id IS NOT NULL;
CREATE INDEX metric_samples_rbs_time_idx
  ON public.metric_samples(rbs_id, kind, collected_at DESC)
  WHERE rbs_id IS NOT NULL;
CREATE INDEX metric_samples_collected_at_idx
  ON public.metric_samples(collected_at DESC);

ALTER TABLE public.metric_samples ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_view_metric_samples ON public.metric_samples
  FOR SELECT TO authenticated USING (true);
-- INSERTs vêm da edge function via service_role (bypassa RLS).

-- 4. Realtime para gráficos ao vivo
-- ------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.metric_samples;
ALTER PUBLICATION supabase_realtime ADD TABLE public.device_interfaces;

-- 5. Função utilitária: limpar amostras > 7 dias (chamada por cron futuramente)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.purge_old_metric_samples()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.metric_samples WHERE collected_at < now() - interval '7 days';
$$;