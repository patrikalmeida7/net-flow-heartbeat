-- 1) Credentials: ciphertext produced by the backend with a key held only in backend secrets.
CREATE TABLE public.acs_server_secrets (
  server_id uuid PRIMARY KEY REFERENCES public.acs_servers(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.acs_server_secrets TO service_role;
REVOKE ALL ON public.acs_server_secrets FROM anon, authenticated;
ALTER TABLE public.acs_server_secrets ENABLE ROW LEVEL SECURITY;
COMMENT ON COLUMN public.acs_servers.password_encrypted IS 'DEPRECATED: weak derived key; replaced by acs_server_secrets. Migrated lazily by tr069-bridge then set NULL.';

ALTER TABLE public.acs_servers ADD COLUMN IF NOT EXISTS allow_insecure_http boolean NOT NULL DEFAULT false;
ALTER TABLE public.acs_servers ADD COLUMN IF NOT EXISTS sync_cursor integer NOT NULL DEFAULT 0;
ALTER TABLE public.acs_servers ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'idle';
ALTER TABLE public.acs_servers ADD COLUMN IF NOT EXISTS sync_seen integer NOT NULL DEFAULT 0;
ALTER TABLE public.acs_servers ADD COLUMN IF NOT EXISTS sync_updated_at timestamptz;

-- Column-level privileges (table-wide SELECT kept the revoked column readable).
REVOKE SELECT, INSERT, UPDATE ON public.acs_servers FROM authenticated;
REVOKE ALL ON public.acs_servers FROM anon;
GRANT SELECT (id, organization_id, nome, nbi_url, cwmp_url, username, enabled, last_check_at, last_error, created_at, updated_at, allow_insecure_http, sync_cursor, sync_status, sync_seen, sync_updated_at)
  ON public.acs_servers TO authenticated;
GRANT INSERT (organization_id, nome, nbi_url, cwmp_url, username, enabled) ON public.acs_servers TO authenticated;
GRANT UPDATE (nome, nbi_url, cwmp_url, username, enabled) ON public.acs_servers TO authenticated;

-- Old weak-key writer is retired; legacy reader stays service-role-only for one-time migration.
REVOKE ALL ON FUNCTION public.set_acs_password(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_acs_password(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_acs_password(uuid) TO service_role;
COMMENT ON FUNCTION public.set_acs_password(uuid, text) IS 'DEPRECATED: passwords are set through tr069-bridge action set_password.';

-- 4/5) Tasks: stable request id, snapshots, unknown state.
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS request_id uuid;
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS profile_snapshot jsonb;
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS observed_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS tr069_tasks_request_uq ON public.tr069_tasks(device_id, request_id) WHERE request_id IS NOT NULL;
DROP INDEX IF EXISTS public.tr069_tasks_one_open_uq;
CREATE UNIQUE INDEX tr069_tasks_one_open_uq ON public.tr069_tasks(device_id, task_type) WHERE status IN ('requested','queued','unknown');

-- 7) Pilot validation on one device (never unlocks the fleet).
ALTER TABLE public.tr069_profiles ADD COLUMN IF NOT EXISTS pilot_device_id uuid REFERENCES public.tr069_devices(id) ON DELETE SET NULL;

CREATE TABLE public.tr069_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  acs_server_id uuid,
  device_id uuid,
  actor uuid,
  action text NOT NULL,
  result text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tr069_audit TO authenticated;
GRANT ALL ON public.tr069_audit TO service_role;
ALTER TABLE public.tr069_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tr069_audit_read ON public.tr069_audit FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin') AND public.is_org_member(auth.uid(), organization_id));
CREATE INDEX tr069_audit_org_idx ON public.tr069_audit(organization_id, created_at DESC);