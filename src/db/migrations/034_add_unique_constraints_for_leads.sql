-- Migration 034: Enforce per-org unique leads by phone/email

-- Prevent duplicate leads with same normalized phone in one org.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_org_phone_unique
  ON leads (org_id, contact_phone)
  WHERE contact_phone IS NOT NULL AND btrim(contact_phone) <> '';

-- Prevent duplicate leads with same email (case-insensitive) in one org.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_org_email_unique
  ON leads (org_id, lower(contact_email))
  WHERE contact_email IS NOT NULL AND btrim(contact_email) <> '';

COMMIT;
