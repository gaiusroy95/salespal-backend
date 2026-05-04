-- Migration 028: Platform settings table for admin-configurable system settings

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}',
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_settings_key ON platform_settings(key);

-- Seed default platform config
INSERT INTO platform_settings (key, value) VALUES
  ('platform_config', '{
    "modules": {
      "marketing": true,
      "sales": true,
      "post-sales": true,
      "support": true
    },
    "features": {
      "ai_calling": true,
      "whatsapp_automation": true
    },
    "maintenance_mode": false
  }'::jsonb),
  ('notification_settings', '{
    "email_enabled": true,
    "whatsapp_enabled": true
  }'::jsonb),
  ('module_pricing', '{
    "marketing": { "monthly": 5999, "yearly": 59990, "enabled": true },
    "sales": { "monthly": 9999, "yearly": 99990, "enabled": true },
    "post-sales": { "monthly": 9999, "yearly": 99990, "enabled": true },
    "support": { "monthly": 9999, "yearly": 99990, "enabled": true },
    "salespal-360": { "monthly": 29999, "yearly": 299990, "enabled": true }
  }'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Add status column to users if not exists (for suspend/ban)
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'banned'));

COMMIT;
