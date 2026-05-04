-- Migration 026: Add unique constraint on (user_id, platform) for integrations
-- The ON CONFLICT (user_id, platform) in the OAuth callbacks requires this constraint.

CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_user_platform
  ON integrations (user_id, platform)
  WHERE user_id IS NOT NULL;

COMMIT;
