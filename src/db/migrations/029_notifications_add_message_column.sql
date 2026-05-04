-- Migration 029: Ensure notifications table has both 'message' and 'metadata' columns
-- The original migration 015 created 'body', migration 017 created 'message'.
-- Depending on which ran first, one column may be missing. This ensures both are present.

-- Add 'message' column if it doesn't exist (for tables created by 015)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT;

-- Add 'metadata' column if it doesn't exist (for tables created by 015)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Copy 'body' data into 'message' where message is NULL but body is not
UPDATE notifications SET message = body WHERE message IS NULL AND body IS NOT NULL;
