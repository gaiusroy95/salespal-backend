-- Migration 020: Ensure token_hash column and indexes for refresh_tokens

-- Enable pgcrypto if not already
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Ensure token_hash column exists
DO $$
BEGIN
    IF NOT EXISTS(
        SELECT 1 FROM information_schema.columns 
        WHERE table_name='refresh_tokens' and column_name='token_hash'
    ) THEN
        ALTER TABLE refresh_tokens ADD COLUMN token_hash TEXT UNIQUE;
    END IF;
END $$;

-- Regular indexes (no CONCURRENTLY to avoid transaction issues)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at) WHERE NOT revoked;

