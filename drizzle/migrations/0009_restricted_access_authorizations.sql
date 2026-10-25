CREATE TABLE public.access_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  full_name text,
  role public.app_role NOT NULL DEFAULT 'visualizador',
  organization_id uuid REFERENCES public.organizations(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%')
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.access_authorizations TO authenticated;
GRANT ALL ON public.access_authorizations TO service_role;
ALTER TABLE public.access_authorizations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.normalize_email(_e text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public AS $$ SELECT lower(btrim(_e)) $$;

-- Active authorization for a user: verified auth email must match exactly (normalized).
CREATE OR REPLACE FUNCTION public.current_authorization(_user_id uuid)
RETURNS public.access_authorizations
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.* FROM public.access_authorizations a
  JOIN auth.users u ON public.normalize_email(u.email) = a.email
  WHERE u.id = _user_id AND u.email_confirmed_at IS NOT NULL
    AND a.status = 'active' AND u.banned_until IS NULL OR (u.id = _user_id AND u.banned_until < now() AND u.email_confirmed_at IS NOT NULL AND a.status='active' AND public.normalize_email(u.email) = a.email)
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_authorized(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (public.current_authorization(_user_id)).id IS NOT NULL
$$;

-- Roles now come only from an active admin-managed authorization. Hierarchy admin > tecnico > visualizador.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((
    SELECT CASE a.role WHEN 'admin' THEN 3 WHEN 'tecnico' THEN 2 ELSE 1 END
      >= CASE _role WHEN 'admin' THEN 3 WHEN 'tecnico' THEN 2 ELSE 1 END
    FROM (SELECT (public.current_authorization(_user_id)).*) a WHERE a.id IS NOT NULL
  ), false)
$$;

CREATE OR REPLACE FUNCTION public.my_access()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN a.id IS NULL THEN jsonb_build_object('status','pending')
    ELSE jsonb_build_object('status','active','role',a.role,'full_name',a.full_name,'organization_id',a.organization_id) END
  FROM (SELECT (public.current_authorization(auth.uid())).*) a
$$;
REVOKE ALL ON FUNCTION public.my_access() FROM anon;
GRANT EXECUTE ON FUNCTION public.my_access() TO authenticated;

-- Admin view of auth accounts with no authorization (pending), without exposing to non-admins.
CREATE OR REPLACE FUNCTION public.admin_list_accounts()
RETURNS TABLE(user_id uuid, email text, created_at timestamptz, last_sign_in_at timestamptz, email_confirmed boolean, providers text[])
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY SELECT u.id, public.normalize_email(u.email), u.created_at, u.last_sign_in_at,
    u.email_confirmed_at IS NOT NULL,
    ARRAY(SELECT DISTINCT i.provider::text FROM auth.identities i WHERE i.user_id = u.id)
  FROM auth.users u ORDER BY u.created_at;
END $$;
REVOKE ALL ON FUNCTION public.admin_list_accounts() FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_list_accounts() TO authenticated;

-- Normalize + protect last active admin (serialized with advisory lock to survive concurrency).
CREATE OR REPLACE FUNCTION public.access_authorizations_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE remaining int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('access_authorizations_last_admin'));
  IF TG_OP IN ('INSERT','UPDATE') THEN
    NEW.email := public.normalize_email(NEW.email);
    NEW.updated_at := now();
    IF TG_OP = 'INSERT' THEN NEW.created_by := auth.uid(); END IF;
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.role = 'admin' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.status <> 'active') THEN
    SELECT count(*) INTO remaining FROM public.access_authorizations
      WHERE role = 'admin' AND status = 'active' AND id <> OLD.id;
    IF remaining = 0 THEN RAISE EXCEPTION 'Não é possível remover ou bloquear o último administrador ativo'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER access_authorizations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.access_authorizations
FOR EACH ROW EXECUTE FUNCTION public.access_authorizations_guard();

CREATE POLICY "admins manage authorizations" ON public.access_authorizations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed: keep the two existing admins authorized; other legacy accounts stay pending.
INSERT INTO public.access_authorizations (email, full_name, role, status)
SELECT DISTINCT public.normalize_email(u.email), p.full_name, 'admin'::public.app_role, 'active'
FROM auth.users u JOIN public.user_roles r ON r.user_id = u.id AND r.role = 'admin'
LEFT JOIN public.profiles p ON p.id = u.id
WHERE u.email IS NOT NULL
ON CONFLICT (email) DO NOTHING;

-- Remove "first user becomes admin" bootstrap; no roles granted on signup.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

-- Every "any authenticated" read now requires an active authorization.
DO $$ DECLARE p record; BEGIN
  FOR p IN SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND qual = 'true' AND 'authenticated' = ANY(roles) LOOP
    EXECUTE format('ALTER POLICY %I ON public.%I USING (public.is_authorized(auth.uid()))', p.policyname, p.tablename);
  END LOOP;
END $$;

COMMENT ON TABLE public.user_roles IS 'DEPRECATED: roles now come from access_authorizations via has_role()';