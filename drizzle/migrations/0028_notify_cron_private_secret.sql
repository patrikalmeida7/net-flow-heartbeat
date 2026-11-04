CREATE TABLE IF NOT EXISTS public.internal_job_secrets (name text PRIMARY KEY, value text NOT NULL);
REVOKE ALL ON public.internal_job_secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.internal_job_secrets TO service_role;
ALTER TABLE public.internal_job_secrets ENABLE ROW LEVEL SECURITY;
INSERT INTO public.internal_job_secrets(name,value) VALUES ('notify_cron', encode(extensions.gen_random_bytes(32),'hex')) ON CONFLICT (name) DO NOTHING;
CREATE OR REPLACE FUNCTION public.check_notify_cron_secret(_s text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(length(_s) >= 32 AND _s = (SELECT value FROM public.internal_job_secrets WHERE name='notify_cron'), false)
$$;
REVOKE ALL ON FUNCTION public.check_notify_cron_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_notify_cron_secret(text) TO service_role;
SELECT cron.alter_job(1, command := $c$select net.http_post(url:='https://rzubqfexhptentnkjcaq.supabase.co/functions/v1/notify-whatsapp', headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT value FROM public.internal_job_secrets WHERE name='notify_cron')), body:='{"action":"run"}'::jsonb)$c$);