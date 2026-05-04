-- Migration 027: Unique index on google_campaign_id for upsert support

-- Allows ON CONFLICT (google_campaign_id) in the sync upsert.
-- The WHERE clause makes this a partial index so NULL google_campaign_ids
-- do not conflict with each other (pre-existing SalesPal-native campaigns).
CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_google_campaign_id
    ON campaigns (google_campaign_id)
    WHERE google_campaign_id IS NOT NULL;

-- Also add a reach column if not present (used by syncPerformance)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS reach BIGINT DEFAULT 0;
