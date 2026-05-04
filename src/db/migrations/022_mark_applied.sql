-- Migration 022: Mark previously applied migrations as done
-- Add entries for migrations that ran before tracking (001-020)

INSERT INTO migration_history (migration_file) VALUES
('001_init_users.sql'),
('002_init_orgs.sql'),
('003_init_refresh_tokens.sql'),
('004_init_projects.sql'),
('005_init_campaigns.sql'),
('006_init_campaign_drafts.sql'),
('007_init_social_posts.sql'),
('008_init_integrations.sql'),
('009_init_subscriptions.sql'),
('010_init_credits.sql'),
('011_init_sales.sql'),
('012_init_campaign_leads.sql'),
('013_init_post_sales.sql'),
('014_init_support.sql'),
('015_init_notifications.sql'),
('016_init_admin_audit_log.sql'),
('017_add_email_verified.sql'),
('018_rename_refresh_token.sql'),
('019_force_rename_token.sql'),
('020_add_token_hash.sql')
ON CONFLICT (migration_file) DO NOTHING;

COMMIT;

