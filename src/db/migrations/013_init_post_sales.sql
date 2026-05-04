CREATE TABLE IF NOT EXISTS post_sales_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  health_score INTEGER DEFAULT 100,
  onboarding_status TEXT DEFAULT 'not_started'
    CHECK(onboarding_status IN('not_started','in_progress','completed')),
  last_contact_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_sales_customers_org ON post_sales_customers(org_id);
CREATE INDEX IF NOT EXISTS idx_post_sales_customers_user ON post_sales_customers(user_id);

CREATE TABLE IF NOT EXISTS post_sales_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES post_sales_customers(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT,
  type TEXT,
  url TEXT,
  extracted_data JSONB DEFAULT '{}',
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_sales_documents_customer ON post_sales_documents(customer_id);
CREATE INDEX IF NOT EXISTS idx_post_sales_documents_org ON post_sales_documents(org_id);

CREATE TABLE IF NOT EXISTS post_sales_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES post_sales_customers(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  amount NUMERIC NOT NULL,
  currency TEXT DEFAULT 'INR',
  status TEXT DEFAULT 'pending' CHECK(status IN('pending','paid','overdue')),
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_sales_payments_customer ON post_sales_payments(customer_id);
CREATE INDEX IF NOT EXISTS idx_post_sales_payments_org ON post_sales_payments(org_id);

CREATE TABLE IF NOT EXISTS post_sales_follow_ups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES post_sales_customers(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending' CHECK(status IN('pending','completed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_sales_follow_ups_customer ON post_sales_follow_ups(customer_id);
CREATE INDEX IF NOT EXISTS idx_post_sales_follow_ups_org ON post_sales_follow_ups(org_id);

CREATE TABLE IF NOT EXISTS post_sales_onboarding (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID UNIQUE REFERENCES post_sales_customers(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  current_step INTEGER DEFAULT 1,
  step_data JSONB DEFAULT '{}',
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_sales_onboarding_org ON post_sales_onboarding(org_id);

CREATE TABLE IF NOT EXISTS post_sales_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  customer_id UUID REFERENCES post_sales_customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger TEXT,
  action TEXT,
  active BOOLEAN DEFAULT true,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_post_sales_automations_org ON post_sales_automations(org_id);
CREATE INDEX IF NOT EXISTS idx_post_sales_automations_customer ON post_sales_automations(customer_id);
