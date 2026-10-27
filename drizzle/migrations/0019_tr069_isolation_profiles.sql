ALTER TABLE public.acs_servers ADD CONSTRAINT acs_servers_org_required CHECK (organization_id IS NOT NULL);
ALTER TABLE public.tr069_devices ADD CONSTRAINT tr069_devices_org_required CHECK (organization_id IS NOT NULL);
ALTER TABLE public.tr069_tasks ADD CONSTRAINT tr069_tasks_org_required CHECK (organization_id IS NOT NULL);
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS acs_server_id uuid REFERENCES public.acs_servers(id) ON DELETE CASCADE;
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS profile_id uuid;
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS confirmation text;
CREATE UNIQUE INDEX IF NOT EXISTS tr069_tasks_idem_uq ON public.tr069_tasks(device_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tr069_tasks_one_open_uq ON public.tr069_tasks(device_id, task_type) WHERE status IN ('requested','queued');
ALTER TABLE public.tr069_devices ADD COLUMN IF NOT EXISTS approved_by uuid;
ALTER TABLE public.tr069_devices ADD COLUMN IF NOT EXISTS approved_at timestamptz;

-- Tighten policies: no NULL-organization escape hatch.
DROP POLICY IF EXISTS acs_admin_all ON public.acs_servers;
DROP POLICY IF EXISTS acs_read ON public.acs_servers;
CREATE POLICY acs_admin_all ON public.acs_servers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') AND public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.has_role(auth.uid(),'admin') AND public.is_org_member(auth.uid(), organization_id));
CREATE POLICY acs_read ON public.acs_servers FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND public.is_org_member(auth.uid(), organization_id));
DROP POLICY IF EXISTS tr069_dev_read ON public.tr069_devices;
DROP POLICY IF EXISTS tr069_dev_admin_upd ON public.tr069_devices;
CREATE POLICY tr069_dev_read ON public.tr069_devices FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND public.is_org_member(auth.uid(), organization_id));
-- Approval only through the bridge (service role); clients cannot flip authorized directly.
REVOKE UPDATE ON public.tr069_devices FROM authenticated;
DROP POLICY IF EXISTS tr069_task_read ON public.tr069_tasks;
CREATE POLICY tr069_task_read ON public.tr069_tasks FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND public.is_org_member(auth.uid(), organization_id));

-- Device/task organization must match their ACS server.
CREATE OR REPLACE FUNCTION public.tr069_org_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o uuid; sid uuid;
BEGIN
  IF TG_TABLE_NAME = 'tr069_devices' THEN sid := NEW.acs_server_id;
  ELSE
    SELECT acs_server_id INTO sid FROM public.tr069_devices WHERE id = NEW.device_id AND organization_id = NEW.organization_id;
    IF sid IS NULL THEN RAISE EXCEPTION 'tr069: device/organization mismatch'; END IF;
    IF NEW.acs_server_id IS NOT NULL AND NEW.acs_server_id <> sid THEN RAISE EXCEPTION 'tr069: server mismatch'; END IF;
    NEW.acs_server_id := sid;
  END IF;
  SELECT organization_id INTO o FROM public.acs_servers WHERE id = sid;
  IF o IS DISTINCT FROM NEW.organization_id THEN RAISE EXCEPTION 'tr069: organization mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tr069_devices_org_guard BEFORE INSERT OR UPDATE ON public.tr069_devices FOR EACH ROW EXECUTE FUNCTION public.tr069_org_guard();
CREATE TRIGGER tr069_tasks_org_guard BEFORE INSERT OR UPDATE ON public.tr069_tasks FOR EACH ROW EXECUTE FUNCTION public.tr069_org_guard();

-- Validated parameter profiles per model/firmware. Writes only allowed with a validated matching profile.
CREATE TABLE public.tr069_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  nome text NOT NULL,
  manufacturer text,
  product_class text,
  model_name text,
  firmware_prefix text,
  data_model text NOT NULL DEFAULT 'tr098' CHECK (data_model IN ('tr098','tr181')),
  wifi_2g_ssid_path text,
  wifi_2g_password_path text,
  wifi_5g_ssid_path text,
  wifi_5g_password_path text,
  allow_reboot boolean NOT NULL DEFAULT false,
  validated boolean NOT NULL DEFAULT false,
  validated_by uuid,
  validated_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tr069_profiles TO authenticated;
GRANT ALL ON public.tr069_profiles TO service_role;
ALTER TABLE public.tr069_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tr069_prof_read ON public.tr069_profiles FOR SELECT TO authenticated
  USING (public.is_authorized(auth.uid()) AND public.is_org_member(auth.uid(), organization_id));
CREATE POLICY tr069_prof_admin ON public.tr069_profiles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin') AND public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.has_role(auth.uid(),'admin') AND public.is_org_member(auth.uid(), organization_id));
CREATE TRIGGER tr069_profiles_updated BEFORE UPDATE ON public.tr069_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();