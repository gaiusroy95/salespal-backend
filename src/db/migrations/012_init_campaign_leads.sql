-- Migration 012: Initialize campaign_leads table

CREATE TABLE IF NOT EXISTS campaign_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  source TEXT,
  ai_score INTEGER CHECK (ai_score BETWEEN 0 AND 100),
  ai_score_label TEXT,
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'called', 'interested', 'converted', 'rejected')),
  last_activity TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_id ON campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_org_id ON campaign_leads(org_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_user_id ON campaign_leads(user_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_deal_id ON campaign_leads(deal_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_status ON campaign_leads(status);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_ai_score ON campaign_leads(ai_score);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_email ON campaign_leads(email);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_phone ON campaign_leads(phone);

CREATE OR REPLACE TRIGGER update_campaign_leads_updated_at BEFORE UPDATE
  ON campaign_leads FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

COMMIT;

