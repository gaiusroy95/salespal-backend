-- Extend lead_actions for CRM activity sync (bot routing, rich metadata)

ALTER TABLE lead_actions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

DO $$
DECLARE
  cname TEXT;
BEGIN
  FOR cname IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'lead_actions'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) LIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE lead_actions DROP CONSTRAINT %I', cname);
  END LOOP;
END $$;

ALTER TABLE lead_actions ADD CONSTRAINT lead_actions_type_check
  CHECK (type IN ('call', 'whatsapp', 'email', 'note', 'meeting', 'ai_action'));
