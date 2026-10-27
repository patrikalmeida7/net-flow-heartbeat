ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS read_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.tr069_tasks ADD COLUMN IF NOT EXISTS last_read_requested_at timestamptz;
COMMENT ON COLUMN public.tr069_tasks.read_attempts IS 'Confirmation read requests sent to the CPE during reconciliation (bounded).';