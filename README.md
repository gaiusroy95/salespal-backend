# Sales-Pal Backend API

Express.js + PostgreSQL API for Sales-Pal. The default deployment story in this repo is **Render** (web service) with a managed Postgres such as **Neon** or **Render PostgreSQL**, and a **Vite** frontend on **Vercel**. Google Cloud Run + Cloud SQL remains supported if you use `DATABASE_URL` or a Unix-socket `DB_HOST`.

## Prerequisites

- **Node.js** v20+ ([download](https://nodejs.org))
- **Docker** ([download](https://docs.docker.com/get-docker/))
- **Google Cloud CLI** (`gcloud`) ([install](https://cloud.google.com/sdk/docs/install))
- **PostgreSQL 15+** (local development) or **Cloud SQL** instance (production)

---

## Local Development Setup

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your local PostgreSQL credentials and JWT secrets:

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your_local_password
DB_NAME=salespal
JWT_ACCESS_SECRET=dev_access_secret_min_32_chars_long
JWT_REFRESH_SECRET=dev_refresh_secret_min_32_chars_long
```

### 3. Create the Database

```bash
createdb salespal
```

### 4. Run Migrations

```bash
npm run migrate
```

### 5. Start the Dev Server

```bash
npm run dev
```

Server starts at `http://localhost:8080`. The `--watch` flag auto-restarts on file changes.

---

## Running Migrations Against Cloud SQL

### Via Cloud SQL Proxy (recommended)

```bash
# Install the proxy
gcloud components install cloud-sql-proxy

# Start proxy (connects to Cloud SQL via IAM)
cloud-sql-proxy YOUR_PROJECT:us-central1:salespal-db --port=5433

# In another terminal, run migrations
DB_HOST=127.0.0.1 DB_PORT=5433 DB_USER=salespal DB_PASSWORD=xxx DB_NAME=salespal node src/db/migrate.js
```

### Via Direct IP (if allowlisted)

```bash
DB_HOST=<CLOUD_SQL_IP> DB_PORT=5432 DB_USER=salespal DB_PASSWORD=xxx DB_NAME=salespal node src/db/migrate.js
```

---

## Docker Build & Push

### Build the Image

```bash
docker build -t salespal-backend .
```

### Test Locally

```bash
docker run --env-file .env -p 8080:8080 salespal-backend
```

### Push to Google Artifact Registry

```bash
# Configure Docker auth
gcloud auth configure-docker us-central1-docker.pkg.dev

# Tag
docker tag salespal-backend us-central1-docker.pkg.dev/YOUR_PROJECT/salespal/backend:latest

# Push
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/salespal/backend:latest
```

---

## Deploy to Render

1. Create a **Web Service** and point it at this repository with **Root Directory** = `backend`.
2. **Build Command:** `npm install` (default is fine).
3. **Start Command:** `npm start` (runs `node server.js`; listens on `process.env.PORT`).
4. In **Environment**, paste values from `.env.example` at minimum:
   - `DATABASE_URL` (Neon or Render Postgres)
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`
   - `CORS_ORIGINS` = your Vercel URL(s)
   - `FRONTEND_URL` = primary Vercel URL
5. After the first deploy (or from your laptop with the same `DATABASE_URL`), run migrations:

```bash
cd backend
npm install
npm run migrate
```

Optional: add a **Render Shell** one-off or a small release script to run `npm run migrate` on each deploy once you are comfortable with automatic schema updates.

---

## Deploy to Cloud Run

```bash
gcloud run deploy salespal-backend \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT/salespal/backend:latest \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --add-cloudsql-instances YOUR_PROJECT:us-central1:salespal-db \
  --set-env-vars "NODE_ENV=production" \
  --set-env-vars "DB_USER=salespal" \
  --set-env-vars "DB_PASSWORD=xxx" \
  --set-env-vars "DB_NAME=salespal" \
  --set-env-vars "CLOUD_SQL_CONNECTION_NAME=YOUR_PROJECT:us-central1:salespal-db" \
  --set-env-vars "DB_SSL=false" \
  --set-env-vars "JWT_ACCESS_SECRET=xxx" \
  --set-env-vars "JWT_REFRESH_SECRET=xxx" \
  --set-env-vars "CORS_ORIGINS=https://your-app.vercel.app" \
  --set-env-vars "GOOGLE_GENERATIVE_AI_API_KEY=xxx" \
  --set-env-vars "FACEBOOK_APP_ID=xxx" \
  --set-env-vars "FACEBOOK_APP_SECRET=xxx" \
  --min-instances 0 \
  --max-instances 10 \
  --memory 512Mi \
  --cpu 1 \
  --port 8080
```

> **Note:** In production, Cloud Run connects to Cloud SQL via Unix socket. Set `CLOUD_SQL_CONNECTION_NAME` and the backend will auto-configure the socket path.

---

## Environment Variables

See **`.env.example`** for a complete template (Render + Vercel + Neon). Highlights:

| Variable              | Required | Description |
| --------------------- | -------- | ----------- |
| `DATABASE_URL`        | **Yes**  | Postgres URL (Neon, Render Postgres, etc.). Prefer this over discrete `DB_*`. |
| `DB_HOST` / `DB_*`    | Alt.     | TCP fields, or Unix socket path if `DB_HOST` starts with `/`. |
| `PORT`                | No       | Listen port (default `8080`; **Render** sets `PORT` automatically). |
| `NODE_ENV`            | No       | `development` \| `production` \| `test` (default `production` in schema). |
| `JWT_ACCESS_SECRET`   | **Yes*** | Access JWT signing secret (min 32 chars if set). |
| `JWT_REFRESH_SECRET`  | **Yes**  | Refresh JWT signing secret. |
| `JWT_SECRET`          | Alt.     | Legacy single secret used for access if `JWT_ACCESS_SECRET` is unset. |
| `JWT_EXPIRES_IN`      | No       | Access token lifetime (default `15m`). |
| `JWT_REFRESH_TTL`     | No       | Refresh lifetime in **seconds** (default `604800`). |
| `FRONTEND_URL`        | Prod     | Public Vercel URL (redirects, OAuth flows). |
| `CORS_ORIGINS`        | Prod     | Allowed browser origins (comma-separated). |
| `GOOGLE_CLIENT_ID`    | No       | Google OAuth (optional unless using Google features). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | **Yes** | Gemini API key used for AI chat/analysis/copy generation. |
| `GEMINI_MARKETING_MODEL`       | No       | Gemini model id (default `gemini-2.5-flash`). |
| `GCP_PROJECT_ID` / `GCP_LOCATION` | Prod | Vertex AI project/location for Imagen/Veo. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | No | Payments. |
| `ENCRYPTION_KEY`      | Prod     | 64 hex chars for integration token encryption. |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | No | Meta integrations. |
| `RATE_LIMIT_*` / `BCRYPT_ROUNDS` / `LOG_LEVEL` | No | Operational tuning. |

\*Provide `JWT_ACCESS_SECRET` **or** a sufficiently long `JWT_SECRET` (see `src/config/env.js`).

---

## API Endpoint Reference

### Authentication (Public)

| Method | Path             | Auth     | Description               |
| ------ | ---------------- | -------- | ------------------------- |
| POST   | `/auth/register` | No       | Register a new user       |
| POST   | `/auth/login`    | No       | Login with email/password |
| POST   | `/auth/refresh`  | No       | Refresh access token      |
| POST   | `/auth/logout`   | Optional | Logout and revoke tokens  |

### Users

| Method | Path         | Auth | Description                 |
| ------ | ------------ | ---- | --------------------------- |
| GET    | `/users/me`  | Yes  | Get current user profile    |
| PUT    | `/users/me`  | Yes  | Update current user profile |
| GET    | `/users/:id` | Yes  | Get user by ID (admin)      |

### Sales (Deals)

| Method | Path         | Auth | Description             |
| ------ | ------------ | ---- | ----------------------- |
| GET    | `/sales`     | Yes  | List deals (filterable) |
| GET    | `/sales/:id` | Yes  | Get deal by ID          |
| POST   | `/sales`     | Yes  | Create a deal           |
| PUT    | `/sales/:id` | Yes  | Update a deal           |
| DELETE | `/sales/:id` | Yes  | Delete a deal           |

### Contacts

| Method | Path            | Auth | Description                |
| ------ | --------------- | ---- | -------------------------- |
| GET    | `/contacts`     | Yes  | List contacts (searchable) |
| GET    | `/contacts/:id` | Yes  | Get contact by ID          |
| POST   | `/contacts`     | Yes  | Create a contact           |
| PUT    | `/contacts/:id` | Yes  | Update a contact           |
| DELETE | `/contacts/:id` | Yes  | Delete a contact           |

### Marketing

| Method | Path                           | Auth | Description                |
| ------ | ------------------------------ | ---- | -------------------------- |
| GET    | `/marketing/campaigns`         | Yes  | List campaigns             |
| GET    | `/marketing/campaigns/:id`     | Yes  | Get campaign by ID         |
| POST   | `/marketing/campaigns`         | Yes  | Create a campaign          |
| PUT    | `/marketing/campaigns/:id`     | Yes  | Update a campaign          |
| DELETE | `/marketing/campaigns/:id`     | Yes  | Delete a campaign          |
| GET    | `/marketing/drafts`            | Yes  | List campaign drafts       |
| POST   | `/marketing/drafts`            | Yes  | Create a draft             |
| PUT    | `/marketing/drafts/:id`        | Yes  | Update a draft             |
| POST   | `/marketing/drafts/:id/launch` | Yes  | Launch a draft as campaign |
| DELETE | `/marketing/drafts/:id`        | Yes  | Delete a draft             |

### Social

| Method | Path                                        | Auth | Description           |
| ------ | ------------------------------------------- | ---- | --------------------- |
| GET    | `/social/posts`                             | Yes  | List social posts     |
| GET    | `/social/posts/:id`                         | Yes  | Get post by ID        |
| POST   | `/social/posts`                             | Yes  | Create a post         |
| PUT    | `/social/posts/:id`                         | Yes  | Update a post         |
| DELETE | `/social/posts/:id`                         | Yes  | Delete a post         |
| GET    | `/social/integrations`                      | Yes  | List integrations     |
| POST   | `/social/integrations/connect`              | Yes  | Connect a platform    |
| POST   | `/social/integrations/disconnect/:platform` | Yes  | Disconnect a platform |

### Support

| Method | Path                    | Auth | Description              |
| ------ | ----------------------- | ---- | ------------------------ |
| GET    | `/support`              | Yes  | List tickets             |
| GET    | `/support/:id`          | Yes  | Get ticket with comments |
| POST   | `/support`              | Yes  | Create a ticket          |
| PUT    | `/support/:id`          | Yes  | Update a ticket          |
| POST   | `/support/:id/comments` | Yes  | Add a comment            |
| DELETE | `/support/:id`          | Yes  | Delete a ticket          |

### Analytics

| Method | Path                                   | Auth | Description                   |
| ------ | -------------------------------------- | ---- | ----------------------------- |
| GET    | `/analytics/dashboard?period=30d`      | Yes  | Full dashboard aggregate      |
| GET    | `/analytics/revenue?period=30d`        | Yes  | Revenue summary               |
| GET    | `/analytics/leads?period=30d`          | Yes  | Lead metrics                  |
| GET    | `/analytics/leads/timeline?period=30d` | Yes  | Leads over time               |
| GET    | `/analytics/platforms?period=30d`      | Yes  | Platform breakdown            |
| GET    | `/analytics/daily?period=30d`          | Yes  | Daily metrics timeseries      |
| GET    | `/analytics/comparison?period=30d`     | Yes  | Period-over-period comparison |

### Billing

| Method | Path                                          | Auth | Description                |
| ------ | --------------------------------------------- | ---- | -------------------------- |
| GET    | `/billing/plans`                              | Yes  | Get available plans        |
| GET    | `/billing/subscriptions`                      | Yes  | Get user subscriptions     |
| POST   | `/billing/subscriptions/activate`             | Yes  | Activate a subscription    |
| POST   | `/billing/subscriptions/:moduleId/deactivate` | Yes  | Cancel a subscription      |
| POST   | `/billing/subscriptions/:moduleId/pause`      | Yes  | Pause a subscription       |
| POST   | `/billing/subscriptions/:moduleId/resume`     | Yes  | Resume a subscription      |
| GET    | `/billing/credits`                            | Yes  | Get credit balance         |
| POST   | `/billing/credits/consume`                    | Yes  | Consume credits            |
| POST   | `/billing/credits/add`                        | Yes  | Add credits                |
| GET    | `/billing/credits/transactions`               | Yes  | Credit transaction history |

### Projects

| Method | Path                    | Auth | Description       |
| ------ | ----------------------- | ---- | ----------------- |
| GET    | `/projects`             | Yes  | List projects     |
| GET    | `/projects/:id`         | Yes  | Get project by ID |
| POST   | `/projects`             | Yes  | Create a project  |
| PUT    | `/projects/:id`         | Yes  | Update a project  |
| POST   | `/projects/:id/archive` | Yes  | Archive a project |
| DELETE | `/projects/:id`         | Yes  | Delete a project  |

### AI

| Method | Path                                | Auth | Description                  |
| ------ | ----------------------------------- | ---- | ---------------------------- |
| POST   | `/ai/chat`                          | Yes  | General AI chat              |
| GET    | `/ai/campaigns/:campaignId/analyze` | Yes  | Analyze campaign performance |
| GET    | `/ai/insights?period=30d`           | Yes  | Strategic marketing insights |
| POST   | `/ai/ad-copy`                       | Yes  | Generate ad copy             |

### System

| Method | Path      | Auth | Description  |
| ------ | --------- | ---- | ------------ |
| GET    | `/health` | No   | Health check |

---

## Additional documentation

- **Supabase → Cloud SQL data migration (legacy):** see `docs/MIGRATION_GUIDE.md`.
