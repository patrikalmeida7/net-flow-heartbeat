CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  slug text UNIQUE,
  plano text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT ALL ON public.organization_members TO service_role;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.organization_members WHERE user_id = _user_id AND organization_id = _org_id)
$$;

CREATE POLICY "members read org" ON public.organizations FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), id) OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admins manage org" ON public.organizations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "members read membership" ON public.organization_members FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "admins manage membership" ON public.organization_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_org_updated BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Organização padrão + todos usuários atuais como membros
INSERT INTO public.organizations (nome, slug) VALUES ('Organização Principal', 'principal');
INSERT INTO public.organization_members (organization_id, user_id, role)
  SELECT (SELECT id FROM public.organizations WHERE slug='principal'), ur.user_id,
         CASE WHEN ur.role='admin' THEN 'owner' ELSE 'member' END
  FROM public.user_roles ur ON CONFLICT DO NOTHING;

ALTER TABLE public.concentradores ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
ALTER TABLE public.agents ADD COLUMN organization_id uuid REFERENCES public.organizations(id);
UPDATE public.concentradores SET organization_id = (SELECT id FROM public.organizations WHERE slug='principal') WHERE organization_id IS NULL;
UPDATE public.agents SET organization_id = (SELECT id FROM public.organizations WHERE slug='principal') WHERE organization_id IS NULL;

-- Credenciais API RouterOS
CREATE TABLE public.mikrotik_api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  concentrador_id uuid NOT NULL UNIQUE REFERENCES public.concentradores(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 8728 CHECK (port BETWEEN 1 AND 65535),
  use_tls boolean NOT NULL DEFAULT false,
  username text NOT NULL,
  password_encrypted bytea,
  password_nonce bytea,
  routeros_version text NOT NULL DEFAULT 'v7' CHECK (routeros_version IN ('v6','v7')),
  enabled boolean NOT NULL DEFAULT true,
  last_poll_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mikrotik_api_credentials TO authenticated;
GRANT ALL ON public.mikrotik_api_credentials TO service_role;
ALTER TABLE public.mikrotik_api_credentials ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins manage mk api" ON public.mikrotik_api_credentials FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER trg_mk_api_updated BEFORE UPDATE ON public.mikrotik_api_credentials FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.set_mikrotik_api_password(_id uuid, _password text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pgsodium AS $$
DECLARE v_key bytea; v_nonce bytea;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
  v_key := pgsodium.crypto_generichash(_id::text::bytea, 'mk_api_v1'::bytea, 32);
  v_nonce := pgsodium.randombytes_buf(24);
  UPDATE public.mikrotik_api_credentials
     SET password_encrypted = pgsodium.crypto_secretbox(_password::bytea, v_nonce, v_key),
         password_nonce = v_nonce, updated_at = now()
   WHERE id = _id;
END $$;

CREATE OR REPLACE FUNCTION public.get_mikrotik_api_password(_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pgsodium AS $$
DECLARE v_row public.mikrotik_api_credentials%ROWTYPE; v_key bytea;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT * INTO v_row FROM public.mikrotik_api_credentials WHERE id = _id;
  IF v_row.password_encrypted IS NULL THEN RETURN NULL; END IF;
  v_key := pgsodium.crypto_generichash(v_row.id::text::bytea, 'mk_api_v1'::bytea, 32);
  RETURN convert_from(pgsodium.crypto_secretbox_open(v_row.password_encrypted, v_row.password_nonce, v_key), 'UTF8');
END $$;
REVOKE EXECUTE ON FUNCTION public.get_mikrotik_api_password(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_mikrotik_api_password(uuid) TO service_role;

-- Novos usuários entram na organização principal
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_org uuid;
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email));
  IF (SELECT COUNT(*) FROM public.user_roles) = 0 THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin');
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'visualizador');
  END IF;
  SELECT id INTO v_org FROM public.organizations WHERE slug = 'principal';
  IF v_org IS NOT NULL THEN
    INSERT INTO public.organization_members (organization_id, user_id) VALUES (v_org, NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END; $function$;