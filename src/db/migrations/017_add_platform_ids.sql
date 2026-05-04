-- Migration 017: Add platform-specific ID and sync columns
-- Safe to re-run: uses DO $$ BEGIN ... EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ============================================================
-- Table: integrations
-- ============================================================

DO $$ BEGIN
    ALTER TABLE integrations ADD COLUMN ad_account_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE integrations ADD COLUMN page_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE integrations ADD COLUMN google_customer_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE integrations ADD COLUMN token_expires_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ============================================================
-- Table: campaigns
-- ============================================================

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN facebook_campaign_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN google_campaign_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE campaigns ADD COLUMN last_synced_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ============================================================
-- Table: campaign_leads
-- ============================================================

DO $$ BEGIN
    ALTER TABLE campaign_leads ADD COLUMN facebook_lead_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE campaign_leads ADD COLUMN google_lead_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- ============================================================
-- Unique indexes (idempotent via IF NOT EXISTS)
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_leads_fb_id
    ON campaign_leads (facebook_lead_id)
    WHERE facebook_lead_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_leads_google_id
    ON campaign_leads (google_lead_id)
    WHERE google_lead_id IS NOT NULL;
