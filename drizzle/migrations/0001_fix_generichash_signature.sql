CREATE OR REPLACE FUNCTION public.set_mikrotik_api_password(_id uuid, _password text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pgsodium'
AS $function$
DECLARE v_key bytea; v_nonce bytea;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
  v_key := pgsodium.crypto_generichash(_id::text::bytea, 'mk_api_v1_key_derivation_32bytes'::bytea);
  v_nonce := pgsodium.randombytes_buf(24);
  UPDATE public.mikrotik_api_credentials
     SET password_encrypted = pgsodium.crypto_secretbox(convert_to(_password,'UTF8'), v_nonce, v_key),
         password_nonce = v_nonce, updated_at = now()
   WHERE id = _id;
END $function$;

CREATE OR REPLACE FUNCTION public.get_mikrotik_api_password(_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pgsodium'
AS $function$
DECLARE v_row public.mikrotik_api_credentials%ROWTYPE; v_key bytea;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_row FROM public.mikrotik_api_credentials WHERE id = _id;
  IF v_row.password_encrypted IS NULL THEN RETURN NULL; END IF;
  v_key := pgsodium.crypto_generichash(v_row.id::text::bytea, 'mk_api_v1_key_derivation_32bytes'::bytea);
  RETURN convert_from(pgsodium.crypto_secretbox_open(v_row.password_encrypted, v_row.password_nonce, v_key), 'UTF8');
END $function$;