-- Migration 005: Initialize campaigns table

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  platform TEXT,
  budget_total NUMERIC DEFAULT 0 CHECK (budget_total >= 0),
  budget_daily NUMERIC DEFAULT 0 CHECK (budget_daily >= 0),
  target_audience JSONB DEFAULT '{}',
  ad_creative JSONB DEFAULT '{}',
  performance JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  launched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_org_id ON campaigns(org_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_project_id ON campaigns(project_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_launched_at ON campaigns(launched_at);

CREATE OR REPLACE TRIGGER update_campaigns_updated_at BEFORE UPDATE
  ON campaigns FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

COMMIT;

