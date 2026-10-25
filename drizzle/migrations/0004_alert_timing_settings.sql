ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS daily_report_minute integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS report_days integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  ADD COLUMN IF NOT EXISTS evening_report_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evening_report_hour integer NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS last_evening_sent_on date,
  ADD COLUMN IF NOT EXISTS quiet_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quiet_start_hour integer NOT NULL DEFAULT 23,
  ADD COLUMN IF NOT EXISTS quiet_end_hour integer NOT NULL DEFAULT 6;
ALTER TABLE public.alert_rules
  ADD COLUMN IF NOT EXISTS window_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS tolerance_minutes integer NOT NULL DEFAULT 0;