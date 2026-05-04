-- Migration 025: Add updated_at to ps_followups (missing from 015)
ALTER TABLE ps_followups
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Backfill existing rows
UPDATE ps_followups SET updated_at = NOW() WHERE updated_at IS NULL;
