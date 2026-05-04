-- Helper script (manual run): dedupe leads before 034_add_unique_constraints_for_leads.sql
-- This file is NOT a migration. Run manually only when needed.
--
-- Usage (psql example):
--   psql "$DATABASE_URL" -f backend/src/db/manual/034a_dedupe_leads_helper.sql
--
-- Strategy:
-- 1) Inspect duplicates by normalized phone/email.
-- 2) Keep the oldest lead in each duplicate group.
-- 3) Re-point campaign_leads.deal_id to kept lead.
-- 4) Delete duplicate lead rows.
--
-- IMPORTANT:
-- - This script is wrapped in a transaction.
-- - The DELETE is active by default; review the "preview" query output first.
-- - Roll back if output is not what you want.

BEGIN;

-- 1) Duplicate summary by phone (per org)
SELECT
  org_id,
  contact_phone,
  COUNT(*) AS duplicate_count,
  ARRAY_AGG(id ORDER BY created_at ASC, id ASC) AS lead_ids
FROM leads
WHERE contact_phone IS NOT NULL AND btrim(contact_phone) <> ''
GROUP BY org_id, contact_phone
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, org_id;

-- 2) Duplicate summary by email (per org, case-insensitive)
SELECT
  org_id,
  lower(contact_email) AS normalized_email,
  COUNT(*) AS duplicate_count,
  ARRAY_AGG(id ORDER BY created_at ASC, id ASC) AS lead_ids
FROM leads
WHERE contact_email IS NOT NULL AND btrim(contact_email) <> ''
GROUP BY org_id, lower(contact_email)
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, org_id;

-- 3) Build mapping of duplicate -> canonical lead (oldest wins)
WITH ranked_phone AS (
  SELECT
    id,
    org_id,
    contact_phone AS dedupe_key,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, contact_phone
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM leads
  WHERE contact_phone IS NOT NULL AND btrim(contact_phone) <> ''
),
ranked_email AS (
  SELECT
    id,
    org_id,
    lower(contact_email) AS dedupe_key,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, lower(contact_email)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM leads
  WHERE contact_email IS NOT NULL AND btrim(contact_email) <> ''
),
phone_map AS (
  SELECT
    p.id AS duplicate_id,
    k.id AS keep_id
  FROM ranked_phone p
  JOIN ranked_phone k
    ON p.org_id = k.org_id
   AND p.dedupe_key = k.dedupe_key
   AND k.rn = 1
  WHERE p.rn > 1
),
email_map AS (
  SELECT
    e.id AS duplicate_id,
    k.id AS keep_id
  FROM ranked_email e
  JOIN ranked_email k
    ON e.org_id = k.org_id
   AND e.dedupe_key = k.dedupe_key
   AND k.rn = 1
  WHERE e.rn > 1
),
all_map AS (
  SELECT duplicate_id, keep_id FROM phone_map
  UNION
  SELECT duplicate_id, keep_id FROM email_map
),
resolved_map AS (
  -- If a row is duplicated by both phone and email, pick a deterministic keep_id.
  SELECT duplicate_id, MIN(keep_id::text)::uuid AS keep_id
  FROM all_map
  GROUP BY duplicate_id
)
-- Preview rows that will be removed/repointed.
SELECT
  rm.duplicate_id,
  rm.keep_id,
  dl.org_id,
  dl.contact_first_name,
  dl.contact_last_name,
  dl.contact_phone,
  dl.contact_email,
  dl.created_at
FROM resolved_map rm
JOIN leads dl ON dl.id = rm.duplicate_id
ORDER BY dl.org_id, dl.created_at;

-- 4) Re-point campaign_leads.deal_id to canonical lead
WITH ranked_phone AS (
  SELECT
    id,
    org_id,
    contact_phone AS dedupe_key,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, contact_phone
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM leads
  WHERE contact_phone IS NOT NULL AND btrim(contact_phone) <> ''
),
ranked_email AS (
  SELECT
    id,
    org_id,
    lower(contact_email) AS dedupe_key,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, lower(contact_email)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM leads
  WHERE contact_email IS NOT NULL AND btrim(contact_email) <> ''
),
all_map AS (
  SELECT p.id AS duplicate_id, k.id AS keep_id
  FROM ranked_phone p
  JOIN ranked_phone k
    ON p.org_id = k.org_id
   AND p.dedupe_key = k.dedupe_key
   AND k.rn = 1
  WHERE p.rn > 1
  UNION
  SELECT e.id AS duplicate_id, k.id AS keep_id
  FROM ranked_email e
  JOIN ranked_email k
    ON e.org_id = k.org_id
   AND e.dedupe_key = k.dedupe_key
   AND k.rn = 1
  WHERE e.rn > 1
),
resolved_map AS (
  SELECT duplicate_id, MIN(keep_id::text)::uuid AS keep_id
  FROM all_map
  GROUP BY duplicate_id
)
UPDATE campaign_leads cl
SET deal_id = rm.keep_id
FROM resolved_map rm
WHERE cl.deal_id = rm.duplicate_id;

-- 5) Delete duplicate lead rows
WITH ranked_phone AS (
  SELECT
    id,
    org_id,
    contact_phone AS dedupe_key,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, contact_phone
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM leads
  WHERE contact_phone IS NOT NULL AND btrim(contact_phone) <> ''
),
ranked_email AS (
  SELECT
    id,
    org_id,
    lower(contact_email) AS dedupe_key,
    ROW_NUMBER() OVER (
      PARTITION BY org_id, lower(contact_email)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM leads
  WHERE contact_email IS NOT NULL AND btrim(contact_email) <> ''
),
all_map AS (
  SELECT p.id AS duplicate_id
  FROM ranked_phone p
  WHERE p.rn > 1
  UNION
  SELECT e.id AS duplicate_id
  FROM ranked_email e
  WHERE e.rn > 1
)
DELETE FROM leads l
USING all_map d
WHERE l.id = d.duplicate_id;

COMMIT;
