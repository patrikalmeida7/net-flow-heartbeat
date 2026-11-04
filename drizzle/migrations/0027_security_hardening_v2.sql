REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;

GRANT SELECT ON public.metric_hourly, public.metric_daily TO authenticated;
GRANT ALL ON public.metric_hourly, public.metric_daily TO service_role;
CREATE POLICY auth_view_metric_hourly ON public.metric_hourly FOR SELECT TO authenticated USING ((SELECT public.is_authorized((SELECT auth.uid()))));
CREATE POLICY auth_view_metric_daily ON public.metric_daily FOR SELECT TO authenticated USING ((SELECT public.is_authorized((SELECT auth.uid()))));

ALTER TABLE public.snmp_credentials ADD COLUMN IF NOT EXISTS community_encrypted bytea, ADD COLUMN IF NOT EXISTS auth_password_encrypted bytea, ADD COLUMN IF NOT EXISTS priv_password_encrypted bytea;
ALTER TABLE public.notification_settings ADD COLUMN IF NOT EXISTS api_token_encrypted bytea;
REVOKE SELECT (community_encrypted, auth_password_encrypted, priv_password_encrypted) ON public.snmp_credentials FROM authenticated;
REVOKE SELECT (api_token_encrypted) ON public.notification_settings FROM authenticated;

CREATE OR REPLACE FUNCTION public.snmp_encrypt_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF NEW.community IS NOT NULL THEN NEW.community_encrypted := extensions.pgp_sym_encrypt(NEW.community, 'snmp_v1:' || NEW.id::text); NEW.community := NULL; END IF;
  IF NEW.auth_password IS NOT NULL THEN NEW.auth_password_encrypted := extensions.pgp_sym_encrypt(NEW.auth_password, 'snmp_v1:' || NEW.id::text); NEW.auth_password := NULL; END IF;
  IF NEW.priv_password IS NOT NULL THEN NEW.priv_password_encrypted := extensions.pgp_sym_encrypt(NEW.priv_password, 'snmp_v1:' || NEW.id::text); NEW.priv_password := NULL; END IF;
  IF NEW.version = 'v2c' THEN NEW.auth_password_encrypted := NULL; NEW.priv_password_encrypted := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS snmp_encrypt ON public.snmp_credentials;
CREATE TRIGGER snmp_encrypt BEFORE INSERT OR UPDATE ON public.snmp_credentials FOR EACH ROW EXECUTE FUNCTION public.snmp_encrypt_trg();
UPDATE public.snmp_credentials SET community = community WHERE community IS NOT NULL OR auth_password IS NOT NULL OR priv_password IS NOT NULL;

CREATE OR REPLACE FUNCTION public.notif_encrypt_trg() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF NEW.api_token IS NOT NULL AND NEW.api_token <> '' THEN NEW.api_token_encrypted := extensions.pgp_sym_encrypt(NEW.api_token, 'notif_v1:' || NEW.id::text); END IF;
  NEW.api_token := NULL;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS notif_encrypt ON public.notification_settings;
CREATE TRIGGER notif_encrypt BEFORE INSERT OR UPDATE ON public.notification_settings FOR EACH ROW EXECUTE FUNCTION public.notif_encrypt_trg();
UPDATE public.notification_settings SET api_token = api_token WHERE api_token IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_snmp_secrets(_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE r public.snmp_credentials%ROWTYPE; k text := 'snmp_v1:' || _id::text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO r FROM public.snmp_credentials WHERE id = _id;
  RETURN jsonb_build_object(
    'community', CASE WHEN r.community_encrypted IS NULL THEN NULL ELSE extensions.pgp_sym_decrypt(r.community_encrypted, k) END,
    'auth_password', CASE WHEN r.auth_password_encrypted IS NULL THEN NULL ELSE extensions.pgp_sym_decrypt(r.auth_password_encrypted, k) END,
    'priv_password', CASE WHEN r.priv_password_encrypted IS NULL THEN NULL ELSE extensions.pgp_sym_decrypt(r.priv_password_encrypted, k) END);
END $$;
CREATE OR REPLACE FUNCTION public.get_notification_api_token(_id uuid) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE v bytea;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT api_token_encrypted INTO v FROM public.notification_settings WHERE id = _id;
  RETURN CASE WHEN v IS NULL THEN NULL ELSE extensions.pgp_sym_decrypt(v, 'notif_v1:' || _id::text) END;
END $$;
REVOKE ALL ON FUNCTION public.get_snmp_secrets(uuid), public.get_notification_api_token(uuid), public.snmp_encrypt_trg(), public.notif_encrypt_trg() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_snmp_secrets(uuid), public.get_notification_api_token(uuid) TO service_role;