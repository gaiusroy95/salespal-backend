-- Migration 024: Analytics columns and campaign_daily_metrics table

-- Add analytics columns to campaigns table
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS impressions BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicks BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS conversions BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS spend NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS revenue NUMERIC(14,2) DEFAULT 0;

-- Add status alias to leads (stage is the canonical column; status is a computed alias)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS status TEXT GENERATED ALWAYS AS (stage) STORED;

-- campaign_daily_metrics: one row per campaign per day
CREATE TABLE IF NOT EXISTS campaign_daily_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  metric_date DATE NOT NULL,
  impressions BIGINT DEFAULT 0,
  clicks BIGINT DEFAULT 0,
  conversions BIGINT DEFAULT 0,
  spend NUMERIC(14,2) DEFAULT 0,
  revenue NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(campaign_id, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_cdm_org_id ON campaign_daily_metrics(org_id);
CREATE INDEX IF NOT EXISTS idx_cdm_campaign_id ON campaign_daily_metrics(campaign_id);
CREATE INDEX IF NOT EXISTS idx_cdm_metric_date ON campaign_daily_metrics(metric_date DESC);

COMMIT;
