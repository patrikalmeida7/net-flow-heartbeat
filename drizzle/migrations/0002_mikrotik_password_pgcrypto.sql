CREATE OR REPLACE FUNCTION public.set_mikrotik_api_password(_id uuid, _password text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE public.mikrotik_api_credentials
     SET password_encrypted = extensions.pgp_sym_encrypt(_password, 'mk_api_v2:' || _id::text),
         password_nonce = '\x7067703a7632'::bytea, updated_at = now()
   WHERE id = _id;
END $function$;

CREATE OR REPLACE FUNCTION public.get_mikrotik_api_password(_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_row public.mikrotik_api_credentials%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_row FROM public.mikrotik_api_credentials WHERE id = _id;
  IF v_row.password_encrypted IS NULL THEN RETURN NULL; END IF;
  RETURN extensions.pgp_sym_decrypt(v_row.password_encrypted, 'mk_api_v2:' || _id::text);
END $function$;