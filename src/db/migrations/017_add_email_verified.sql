-- Migration: 017_add_email_verified
-- Adds the missing email_verified column to the users table which is required for Google OAuth provisioning

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE;
