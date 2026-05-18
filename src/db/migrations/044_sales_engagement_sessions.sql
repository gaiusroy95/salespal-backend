-- Migration 044: Unified cross-channel sales engagement session + state machine audit log

CREATE TABLE IF NOT EXISTS sales_engagement_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'lead_created',
  preferred_locale TEXT NOT NULL DEFAULT 'hing',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  lead_type TEXT CHECK (lead_type IS NULL OR lead_type IN ('hot', 'warm', 'cold')),
  qualification JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_call_summary TEXT,
  last_whatsapp_summary TEXT,
  active_voice_conversation_id TEXT,
  promises JSONB NOT NULL DEFAULT '[]'::jsonb,
  objections JSONB NOT NULL DEFAULT '[]'::jsonb,
  shared_files JSONB NOT NULL DEFAULT '[]'::jsonb,
  meeting_status TEXT,
  visit_status TEXT,
  ai_score INTEGER CHECK (ai_score IS NULL OR (ai_score >= 0 AND ai_score <= 100)),
  escalation_risk TEXT CHECK (escalation_risk IS NULL OR escalation_risk IN ('low', 'medium', 'high', 'critical')),
  next_action TEXT,
  next_action_at TIMESTAMPTZ,
  human_takeover BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_sales_engagement_sessions_lead UNIQUE (lead_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_engagement_sessions_org_state
  ON sales_engagement_sessions (org_id, state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_engagement_sessions_voice_conv
  ON sales_engagement_sessions (active_voice_conversation_id)
  WHERE active_voice_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES sales_engagement_sessions(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event TEXT NOT NULL,
  channel TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_engagement_events_lead_created
  ON sales_engagement_events (lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_engagement_events_session_created
  ON sales_engagement_events (session_id, created_at DESC);
