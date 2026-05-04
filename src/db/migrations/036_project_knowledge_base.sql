-- Migration 036: Project knowledge base for SalesPal 360 central intelligence

CREATE TABLE IF NOT EXISTS project_knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('website', 'business_description', 'pdf', 'logo')),
  source_name TEXT,
  content TEXT NOT NULL,
  embedding JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}',
  knowledge_version INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_knowledge_project_id ON project_knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_org_id ON project_knowledge(org_id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_source_type ON project_knowledge(source_type);

COMMIT;
