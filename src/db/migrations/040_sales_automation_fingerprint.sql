ALTER TABLE sales_automation_jobs
  ADD COLUMN IF NOT EXISTS fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_automation_jobs_pending_fingerprint
  ON sales_automation_jobs (org_id, user_id, lead_id, fingerprint)
  WHERE status = 'pending' AND fingerprint IS NOT NULL;

