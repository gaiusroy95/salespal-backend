-- Migration 009: Initialize subscriptions table

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  module TEXT CHECK (module IN ('marketing', 'sales', 'postSale', 'support', 'salespal360')),
  status TEXT DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'paused')),
  activated_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, module)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org_id ON subscriptions(org_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_module ON subscriptions(module);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

CREATE OR REPLACE TRIGGER update_subscriptions_updated_at BEFORE UPDATE
  ON subscriptions FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

COMMIT;

