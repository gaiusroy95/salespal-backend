-- Migration 014: Patch subscriptions and credit_transactions tables

-- ─── Subscriptions: add plan, expires_at, cancelled_at ──────────────────────
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Update UNIQUE constraint to also support user_id+module (billing service uses both)
-- The existing UNIQUE(org_id, module) stays; add a partial index for user_id+module
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user_module
  ON subscriptions(user_id, module) WHERE user_id IS NOT NULL;

-- ─── credit_transactions: add balance_after, reference_type ─────────────────
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS balance_after INTEGER;
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS reference_type TEXT;

-- Widen the type CHECK to include 'credit' and 'debit' used by billing.service.js
-- (existing values: 'consume', 'add', 'refund')
ALTER TABLE credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('consume', 'add', 'refund', 'credit', 'debit'));

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_credit_transactions_reference_type ON credit_transactions(reference_type);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at ON subscriptions(expires_at);

COMMIT;
