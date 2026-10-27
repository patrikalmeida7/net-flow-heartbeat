GRANT ALL ON public.acs_servers TO service_role;
GRANT SELECT (id, organization_id, nome, nbi_url, cwmp_url, username, enabled, last_check_at, last_error, created_at, updated_at, allow_insecure_http, sync_cursor, sync_status, sync_seen, sync_updated_at) ON public.acs_servers TO authenticated;
GRANT INSERT (organization_id, nome, nbi_url, cwmp_url, username, enabled, allow_insecure_http) ON public.acs_servers TO authenticated;
GRANT UPDATE (nome, nbi_url, cwmp_url, username, enabled, allow_insecure_http) ON public.acs_servers TO authenticated;
GRANT DELETE ON public.acs_servers TO authenticated;
GRANT ALL ON public.acs_server_secrets TO service_role;