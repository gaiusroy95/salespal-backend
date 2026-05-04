# Supabase → Cloud SQL Migration Guide

Complete guide for migrating Sales-Pal from Supabase to the new Express.js + Cloud SQL backend.

---

## 1. Export Data from Supabase

### Option A: Supabase Dashboard (Recommended for small datasets)

1. Go to **Table Editor** in your Supabase Dashboard
2. For each table, click **Export to CSV**
3. Save CSV files for: `organizations`, `org_members`, `users` (if custom auth data), `campaigns`, `campaign_drafts`, `social_posts`, `integrations`, `projects`

### Option B: Supabase CLI

```bash
# Install Supabase CLI
npm install -g supabase

# Link to your project
supabase link --project-ref YOUR_PROJECT_REF

# Export via pg_dump
supabase db dump --data-only > supabase_data_dump.sql
```

### Option C: Direct psql Export

```bash
# Get connection string from Supabase Settings > Database
PGPASSWORD=xxx pg_dump -h db.YOUR_PROJECT.supabase.co -U postgres -d postgres \
  --data-only --no-owner --no-acl \
  -t organizations -t org_members -t campaigns -t campaign_drafts \
  -t social_posts -t integrations -t projects \
  > supabase_data.sql
```

---

## 2. Import Data into Cloud SQL

### Prepare the Cloud SQL database

```bash
# Run migrations first to create all tables
cd backend
npm run migrate
```

### Import from SQL dump

```bash
# Via Cloud SQL Proxy
cloud-sql-proxy YOUR_PROJECT:us-central1:salespal-db --port=5433 &

PGPASSWORD=xxx psql -h 127.0.0.1 -p 5433 -U salespal -d salespal < supabase_data.sql
```

### Import from CSV files

For each table, use PostgreSQL `COPY`:

```sql
-- Example: importing organizations
\COPY organizations(id, name, slug, metadata, created_at, updated_at) FROM 'organizations.csv' WITH (FORMAT csv, HEADER true);

-- Example: importing campaigns
\COPY campaigns(id, org_id, project_id, name, platform, objective, status, daily_budget, total_budget, start_date, end_date, impressions, clicks, conversions, spend, revenue, reach, metadata, created_by, created_at, updated_at) FROM 'campaigns.csv' WITH (FORMAT csv, HEADER true);
```

### Column Name Mapping

Supabase tables may use different column names. Key mappings:

| Supabase Column             | Cloud SQL Column | Table                  |
| --------------------------- | ---------------- | ---------------------- |
| `user_id` (from auth.users) | `user_id`        | All user-owned tables  |
| `created_at` (auto)         | `created_at`     | All tables             |
| Any `auth.uid()` reference  | `user_id UUID`   | Foreign key to `users` |

### User Migration

Since Supabase uses its own `auth.users` table, you must re-create users:

```sql
-- Extract user data from Supabase auth schema
-- Note: passwords CANNOT be exported from Supabase auth
-- All users must reset their password or re-register

-- If you have metadata in auth.users.raw_user_meta_data:
INSERT INTO users (id, email, full_name, role, created_at)
SELECT
  id,
  email,
  raw_user_meta_data->>'full_name',
  'user',
  created_at
FROM auth.users;
```

---

## 3. Update Frontend to Use New Backend API

Every file that currently imports from `@supabase/supabase-js` or calls `supabase.from(...)` must be updated to use `fetch()` calls to the new REST API.

### Files Requiring Changes

#### `src/lib/supabase.js` → **DELETE** (replaced by API client)

Create a new `src/lib/api.js`:

```javascript
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8080";

async function api(path, options = {}) {
  const token = localStorage.getItem("accessToken");
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    // Attempt token refresh
    const refreshed = await refreshToken();
    if (refreshed) return api(path, options); // Retry
    // Redirect to login
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Request failed");
  }

  return response.json();
}

async function refreshToken() {
  const refresh = localStorage.getItem("refreshToken");
  if (!refresh) return false;

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    localStorage.setItem("accessToken", data.accessToken);
    localStorage.setItem("refreshToken", data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export default api;
export const get = (path) => api(path);
export const post = (path, body) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
export const put = (path, body) =>
  api(path, { method: "PUT", body: JSON.stringify(body) });
export const del = (path) => api(path, { method: "DELETE" });
```

#### `src/context/AuthContext.jsx`

| Before (Supabase)                    | After (REST API)                                        |
| ------------------------------------ | ------------------------------------------------------- |
| `supabase.auth.signUp()`             | `post('/auth/register', { email, password, fullName })` |
| `supabase.auth.signInWithPassword()` | `post('/auth/login', { email, password })`              |
| `supabase.auth.signOut()`            | `post('/auth/logout', { refreshToken })`                |
| `supabase.auth.onAuthStateChange()`  | Check `localStorage` for access token on mount          |
| `supabase.auth.getSession()`         | Decode JWT from `localStorage` or call `GET /users/me`  |

#### `src/context/OrgContext.jsx`

| Before                                    | After                                 |
| ----------------------------------------- | ------------------------------------- |
| `supabase.from('organizations').select()` | `get('/users/me')` (returns org info) |
| `supabase.from('org_members').select()`   | Included in `/users/me` response      |

#### `src/context/MarketingContext.jsx` / `CampaignContext.jsx`

| Before                                | After                                   |
| ------------------------------------- | --------------------------------------- |
| `supabase.from('campaigns').select()` | `get('/marketing/campaigns')`           |
| `supabase.from('campaigns').insert()` | `post('/marketing/campaigns', data)`    |
| `supabase.from('campaigns').update()` | `put('/marketing/campaigns/:id', data)` |
| `supabase.from('campaigns').delete()` | `del('/marketing/campaigns/:id')`       |
| `supabase.from('campaign_drafts').*`  | Use `/marketing/drafts/*` endpoints     |

#### `src/context/SocialContext.jsx`

| Before                                   | After                         |
| ---------------------------------------- | ----------------------------- |
| `supabase.from('social_posts').select()` | `get('/social/posts')`        |
| `supabase.from('social_posts').insert()` | `post('/social/posts', data)` |

#### `src/context/IntegrationContext.jsx`

| Before                                   | After                                        |
| ---------------------------------------- | -------------------------------------------- |
| `supabase.from('integrations').select()` | `get('/social/integrations')`                |
| `supabase.from('integrations').upsert()` | `post('/social/integrations/connect', data)` |

#### `src/context/AnalyticsContext.jsx`

| Before                                                | After                                      |
| ----------------------------------------------------- | ------------------------------------------ |
| Client-side calculation in `analyticsCalculations.js` | `get('/analytics/dashboard?period=30d')`   |
| Manual aggregation of campaigns                       | Server-side aggregation via `/analytics/*` |

#### `src/context/NotificationContext.jsx`

| Before                                    | After                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `supabase.from('notifications').select()` | Notifications should be moved to the backend (or keep client-side if simple) |

#### `src/commerce/SubscriptionContext.jsx`

| Before                                    | After                                                   |
| ----------------------------------------- | ------------------------------------------------------- |
| `supabase.from('subscriptions').select()` | `get('/billing/subscriptions')`                         |
| `supabase.from('subscriptions').upsert()` | `post('/billing/subscriptions/activate', { moduleId })` |

#### `src/commerce/CartContext.jsx`

Cart state can remain client-side (localStorage) since it's session-only.

#### `src/hooks/useProjects.js`

| Before                               | After                        |
| ------------------------------------ | ---------------------------- |
| `supabase.from('projects').select()` | `get('/projects')`           |
| `supabase.from('projects').insert()` | `post('/projects', data)`    |
| `supabase.from('projects').update()` | `put('/projects/:id', data)` |
| `supabase.from('projects').delete()` | `del('/projects/:id')`       |

#### `src/utils/analyticsCalculations.js`

**Can be greatly simplified or deleted.** All metric aggregation now happens server-side in the `/analytics/*` endpoints. The frontend only needs to display the pre-computed results.

#### `src/utils/campaignGuard.js`

Keep as-is — this is a frontend navigation guard that checks subscription status. Update it to call `get('/billing/subscriptions')` instead of reading from Supabase context.

---

## 4. Auth Cutover — Handling Existing Sessions

### Problem

All existing Supabase JWTs become invalid after migration. Users with active sessions will be logged out.

### Approach

1. **Set a cutover date** and communicate it to all users
2. **Before cutover**: Deploy the new backend, run migrations, import data
3. **During cutover**:
   - Update frontend env vars to point to the new API URL
   - Deploy updated frontend to Vercel
   - All existing Supabase sessions expire immediately
4. **After cutover**: Users must re-register or reset their password since Supabase password hashes are not exportable

### Password Reset Flow

Since bcrypt hashes from Supabase's auth schema cannot be exported:

1. Add a "legacy" migration flag to user records
2. On first login attempt after migration, show a "Reset your password" prompt
3. Send a password reset email using your own SMTP service
4. Once the user resets, update their `password_hash` in the new system

---

## 5. Rollback Plan

If the migration fails mid-way:

### Immediate Rollback (within 24 hours)

1. **Revert frontend deployment**: Roll back the Vercel deployment to the last commit that used Supabase
2. **Supabase data is untouched**: Since we exported (not deleted) data from Supabase, all original data remains intact
3. **DNS/API URL**: If using a custom API domain, point it back to the Supabase API URL
4. **Cleanup**: Pause or delete the Cloud Run service and Cloud SQL instance to stop billing

### Partial Rollback (data was written to new backend)

If users created new data on the new backend before you rolled back:

1. Export any new records from Cloud SQL that were created after the cutover timestamp
2. Use `INSERT ... ON CONFLICT DO NOTHING` to merge them back into Supabase if possible
3. Deploy the Supabase frontend version

### Pre-Migration Checklist

- [ ] Full Supabase data export completed and verified
- [ ] Cloud SQL instance provisioned and migrations run
- [ ] Data import completed and row counts verified
- [ ] New backend deployed to Cloud Run and health check passes
- [ ] Frontend updated with new API URL and tested in staging
- [ ] All team members notified of cutover window
- [ ] Rollback procedure tested on staging
- [ ] DNS TTL lowered to 60s (if using custom domain) 24 hours before cutover
