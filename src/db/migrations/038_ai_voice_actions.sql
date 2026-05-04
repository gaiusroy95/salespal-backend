-- Migration 038: Voice handshake actions and escalation tracking

CREATE TABLE IF NOT EXISTS ai_voice_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_voice_actions_org_id ON ai_voice_actions(org_id);
CREATE INDEX IF NOT EXISTS idx_ai_voice_actions_action_type ON ai_voice_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_ai_voice_actions_created_at ON ai_voice_actions(created_at);

COMMIT;
