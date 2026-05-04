CREATE TABLE IF NOT EXISTS sales_automation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('call', 'whatsapp', 'ai_chat')),
  target_channel TEXT NOT NULL CHECK (target_channel IN ('call', 'whatsapp')),
  schedule_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'cancelled', 'completed')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dispatched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_automation_jobs_due
  ON sales_automation_jobs (org_id, user_id, status, schedule_at);

