-- Migration 006: Initialize campaign_drafts table

CREATE TABLE IF NOT EXISTS campaign_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  step INTEGER DEFAULT 1 CHECK (step >= 1),
  draft_data JSONB DEFAULT '{}',
  analysis_done BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_drafts_org_id ON campaign_drafts(org_id);
CREATE INDEX IF NOT EXISTS idx_campaign_drafts_user_id ON campaign_drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_drafts_project_id ON campaign_drafts(project_id);
CREATE INDEX IF NOT EXISTS idx_campaign_drafts_analysis_done ON campaign_drafts(analysis_done);

CREATE OR REPLACE TRIGGER update_campaign_drafts_updated_at BEFORE UPDATE
  ON campaign_drafts FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

COMMIT;

