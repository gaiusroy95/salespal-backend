-- Enable pgvector extension (Neon supports this natively)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add a real vector column alongside the existing JSONB embedding
ALTER TABLE project_knowledge ADD COLUMN IF NOT EXISTS embedding_vec vector(768);

-- Create an IVFFlat index for fast approximate nearest-neighbor search
-- (uses cosine distance; lists=100 is good for up to ~100k rows)
CREATE INDEX IF NOT EXISTS idx_project_knowledge_embedding_vec
  ON project_knowledge
  USING ivfflat (embedding_vec vector_cosine_ops)
  WITH (lists = 100);

COMMIT;
