-- Migration 013: Patch campaigns table with full marketing columns + add metadata to users

-- ─── Users: add metadata column ─────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ─── Campaigns: add all columns used by marketing.controller.js ─────────────
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS objective TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_budget NUMERIC DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_budget NUMERIC DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ad_platforms TEXT[] DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ad_format TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS headline TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS primary_text TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS cta TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS media_type TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS media_url TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS budget_platforms TEXT[] DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS budget_split JSONB DEFAULT '{}';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'INR';
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- ─── campaign_drafts: add wizard_step column ─────────────────────────────────
ALTER TABLE campaign_drafts ADD COLUMN IF NOT EXISTS wizard_step INTEGER DEFAULT 1;

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON campaigns(created_by);
CREATE INDEX IF NOT EXISTS idx_campaigns_currency ON campaigns(currency);

COMMIT;
