-- Migration 041: Add metadata envelope to voice sessions

ALTER TABLE ai_voice_sessions
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_metadata_project
  ON ai_voice_sessions ((metadata->>'projectId'));

