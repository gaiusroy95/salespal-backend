-- Migration 037: Social Studio staged approval posts

CREATE TABLE IF NOT EXISTS social_studio_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  festival TEXT,
  body TEXT NOT NULL,
  media_url TEXT,
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged', 'approved', 'published', 'rejected')),
  scheduled_at TIMESTAMPTZ,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_studio_posts_org_id ON social_studio_posts(org_id);
CREATE INDEX IF NOT EXISTS idx_social_studio_posts_status ON social_studio_posts(status);

COMMIT;
