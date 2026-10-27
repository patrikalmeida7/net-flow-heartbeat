CREATE TABLE public.acs_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  nome text NOT NULL,
  nbi_url text NOT NULL,
  cwmp_url text,
  username text,
  password_encrypted bytea,
  enabled boolean NOT NULL DEFAULT true,
  last_check_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.acs_servers TO authenticated;
GRANT ALL ON public.acs_servers TO service_role;
REVOKE SELECT (password_encrypted) ON public.acs_servers FROM authenticated;
ALTER TABLE public.acs_servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY acs_admin_all ON public.acs_servers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)))
  WITH CHECK (public.has_role(auth.uid(),'admin') AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));
CREATE POLICY acs_read ON public.acs_servers FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));

CREATE TABLE public.tr069_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  acs_server_id uuid NOT NULL REFERENCES public.acs_servers(id) ON DELETE CASCADE,
  genie_id text NOT NULL,
  serial_number text,
  manufacturer text,
  oui text,
  product_class text,
  model_name text,
  software_version text,
  ip_address text,
  pppoe_username text,
  wifi_ssid text,
  wifi_ssid_5g text,
  authorized boolean NOT NULL DEFAULT false,
  last_inform_at timestamptz,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (acs_server_id, genie_id)
);
GRANT SELECT, UPDATE ON public.tr069_devices TO authenticated;
GRANT ALL ON public.tr069_devices TO service_role;
ALTER TABLE public.tr069_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tr069_dev_read ON public.tr069_devices FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));
CREATE POLICY tr069_dev_admin_upd ON public.tr069_devices FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin') AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)))
  WITH CHECK (public.has_role(auth.uid(),'admin') AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));

CREATE TABLE public.tr069_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id),
  device_id uuid NOT NULL REFERENCES public.tr069_devices(id) ON DELETE CASCADE,
  task_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  genie_task_id text,
  error text,
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
GRANT SELECT ON public.tr069_tasks TO authenticated;
GRANT ALL ON public.tr069_tasks TO service_role;
ALTER TABLE public.tr069_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tr069_task_read ON public.tr069_tasks FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id)));
CREATE INDEX tr069_tasks_device_idx ON public.tr069_tasks(device_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_acs_password(_id uuid, _password text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'forbidden'; END IF;
  UPDATE public.acs_servers SET password_encrypted = extensions.pgp_sym_encrypt(_password, 'acs_v1:' || _id::text), updated_at = now()
   WHERE id = _id AND (organization_id IS NULL OR public.is_org_member(auth.uid(), organization_id));
END $$;
CREATE OR REPLACE FUNCTION public.get_acs_password(_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
DECLARE v bytea;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'forbidden'; END IF;
  SELECT password_encrypted INTO v FROM public.acs_servers WHERE id = _id;
  IF v IS NULL THEN RETURN NULL; END IF;
  RETURN extensions.pgp_sym_decrypt(v, 'acs_v1:' || _id::text);
END $$;
REVOKE ALL ON FUNCTION public.get_acs_password(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_acs_password(uuid) TO service_role;