-- Migration 033: Persist AI voice sessions / turns and video generation jobs

CREATE TABLE IF NOT EXISTS ai_voice_sessions (
  conversation_id TEXT PRIMARY KEY,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  brand_id TEXT NOT NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  contact_phone TEXT,
  contact_name TEXT,
  locale TEXT NOT NULL DEFAULT 'hing',
  state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'complete')),
  mode TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ai_voice_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL REFERENCES ai_voice_sessions(conversation_id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_org_id ON ai_voice_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_user_id ON ai_voice_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_lead_id ON ai_voice_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_ai_voice_sessions_created_at ON ai_voice_sessions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_voice_turns_conversation_id ON ai_voice_turns(conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_voice_turns_created_at ON ai_voice_turns(created_at);

CREATE TABLE IF NOT EXISTS ai_video_jobs (
  job_id TEXT PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  prompt TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL DEFAULT '',
  brand_name TEXT NOT NULL DEFAULT '',
  website_url TEXT,
  locale TEXT NOT NULL DEFAULT 'en',
  video_url TEXT,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_video_jobs_org_id ON ai_video_jobs(org_id);
CREATE INDEX IF NOT EXISTS idx_ai_video_jobs_user_id ON ai_video_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_video_jobs_status ON ai_video_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ai_video_jobs_created_at ON ai_video_jobs(created_at DESC);

CREATE OR REPLACE TRIGGER update_ai_voice_sessions_updated_at BEFORE UPDATE ON ai_voice_sessions
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ai_video_jobs_updated_at BEFORE UPDATE ON ai_video_jobs
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();
