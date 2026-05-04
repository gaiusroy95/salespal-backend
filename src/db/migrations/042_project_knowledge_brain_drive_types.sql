-- Brain Drive: allow plain text, Google Drive links, and webpage as first-class knowledge sources
-- (existing: website, business_description, pdf, logo)

ALTER TABLE project_knowledge DROP CONSTRAINT IF EXISTS project_knowledge_source_type_check;

ALTER TABLE project_knowledge ADD CONSTRAINT project_knowledge_source_type_check CHECK (
  source_type IN (
    'website',
    'business_description',
    'pdf',
    'logo',
    'plain_text',
    'drive_link',
    'webpage'
  )
);

COMMIT;
