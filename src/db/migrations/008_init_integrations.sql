-- Migration 008: Initialize integrations table

CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  platform TEXT CHECK (platform IN ('meta', 'google', 'linkedin')),
  status TEXT DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected')),
  access_token_enc TEXT,
  metadata JSONB DEFAULT '{}',
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_integrations_org_id ON integrations(org_id);
CREATE INDEX IF NOT EXISTS idx_integrations_user_id ON integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_platform ON integrations(platform);
CREATE INDEX IF NOT EXISTS idx_integrations_status ON integrations(status);

CREATE OR REPLACE TRIGGER update_integrations_updated_at BEFORE UPDATE
  ON integrations FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

COMMIT;

