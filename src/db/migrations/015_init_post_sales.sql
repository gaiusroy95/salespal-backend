-- Migration 015: Initialize post-sales tables

CREATE TABLE IF NOT EXISTS ps_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  company TEXT,
  total_due NUMERIC DEFAULT 0,
  amount_paid NUMERIC DEFAULT 0,
  due_date DATE,
  currency TEXT DEFAULT 'INR',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'overdue')),
  last_contact DATE,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ps_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES ps_customers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'INR',
  method TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  paid_at TIMESTAMPTZ,
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ps_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  action TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ps_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES ps_customers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  task TEXT NOT NULL,
  due_date DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ps_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES ps_customers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT,
  file_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ps_onboarding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES ps_customers(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  step_name TEXT NOT NULL,
  step_order INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  notes TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, step_name)
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ps_customers_user_id ON ps_customers(user_id);
CREATE INDEX IF NOT EXISTS idx_ps_customers_org_id ON ps_customers(org_id);
CREATE INDEX IF NOT EXISTS idx_ps_customers_status ON ps_customers(status);
CREATE INDEX IF NOT EXISTS idx_ps_payments_customer_id ON ps_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_ps_payments_user_id ON ps_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_ps_payments_status ON ps_payments(status);
CREATE INDEX IF NOT EXISTS idx_ps_automations_user_id ON ps_automations(user_id);
CREATE INDEX IF NOT EXISTS idx_ps_automations_org_id ON ps_automations(org_id);
CREATE INDEX IF NOT EXISTS idx_ps_followups_customer_id ON ps_followups(customer_id);
CREATE INDEX IF NOT EXISTS idx_ps_followups_user_id ON ps_followups(user_id);
CREATE INDEX IF NOT EXISTS idx_ps_documents_customer_id ON ps_documents(customer_id);
CREATE INDEX IF NOT EXISTS idx_ps_onboarding_customer_id ON ps_onboarding(customer_id);

-- ─── Triggers ────────────────────────────────────────────────────────────────
CREATE OR REPLACE TRIGGER update_ps_customers_updated_at
  BEFORE UPDATE ON ps_customers FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ps_payments_updated_at
  BEFORE UPDATE ON ps_payments FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ps_automations_updated_at
  BEFORE UPDATE ON ps_automations FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ps_followups_updated_at
  BEFORE UPDATE ON ps_followups FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ps_documents_updated_at
  BEFORE UPDATE ON ps_documents FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

CREATE OR REPLACE TRIGGER update_ps_onboarding_updated_at
  BEFORE UPDATE ON ps_onboarding FOR EACH ROW EXECUTE PROCEDURE update_updated_at_column();

COMMIT;
