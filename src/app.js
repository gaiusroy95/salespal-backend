const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const env = require('./config/env');
const logger = require('./config/logger');
const errorHandler = require('./middleware/errorHandler');
const { authMiddleware } = require('./middleware/auth');
const { defaultLimiter } = require('./middleware/rateLimiter');

// Route imports
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const salesRoutes = require('./routes/sales');
const marketingRoutes = require('./routes/marketing');
const socialRoutes = require('./routes/social');
const supportRoutes = require('./routes/support');
const analyticsRoutes = require('./routes/analytics');
const billingRoutes = require('./routes/billing');
const projectsRoutes = require('./routes/projects');
const aiRoutes = require('./routes/ai');
const postSalesRoutes = require('./routes/post-sales');

// New Routes
const orgsRoutes = require('./routes/orgs');
const salesCampaignsRoutes = require('./routes/salesCampaigns');
const integrationsRoutes = require('./routes/integrations');
const subscriptionsRoutes = require('./routes/subscriptions');
const creditsRoutes = require('./routes/credits');
const notificationsRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');
const utilsRoutes = require('./routes/utils');
const testImageRoute = require('./routes/testImage');
const paymentRoutes = require('./routes/payment');
const paymentWebhookRoutes = require('./routes/payment-webhook');
const webhookRoutes = require('./routes/webhooks');
const invoiceRoutes = require('./routes/invoice');
const pricingRoutes = require('./routes/pricing');
const maintenanceRoutes = require('./routes/maintenance');
const demoAiRoutes = require('./routes/demo-ai');
const { requireModuleAccess } = require('./middleware/entitlements');

const app = express();

/**
 * Behind Render / nginx / cloud load balancers, the TCP peer is the proxy, not the browser.
 * Without trust proxy, req.ip is identical for all users and global rate limits apply to
 * everyone as a single bucket → frequent 429 "Too many requests" for normal usage.
 */
(() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === 'false' || raw === '0') {
    app.set('trust proxy', false);
    return;
  }
  if (raw === undefined || raw === '') {
    app.set('trust proxy', 1);
    return;
  }
  const n = Number(raw);
  app.set('trust proxy', Number.isFinite(n) && n >= 0 ? n : 1);
})();

/**
 * CORS: Vercel + Render deployments often set CORS_ORIGINS to the marketing domain only.
 * Browsers require Access-Control-Allow-Origin to echo the *page* origin (e.g. salespal-frontend.vercel.app).
 * We always merge FRONTEND_URL + CORS_ORIGINS (when not *) so API + SPA stay aligned.
 */
function collectAllowedOrigins() {
  const origins = new Set();
  const add = (value) => {
    if (!value || typeof value !== 'string') return;
    const s = value.trim();
    if (!s) return;
    try {
      origins.add(new URL(s).origin);
    } catch {
      origins.add(s.replace(/\/$/, ''));
    }
  };
  if (Array.isArray(env.frontendOrigins) && env.frontendOrigins.length) {
    env.frontendOrigins.forEach(add);
  } else {
    add(env.FRONTEND_URL);
  }
  if (env.corsOrigins !== '*' && Array.isArray(env.corsOrigins)) {
    env.corsOrigins.forEach(add);
  }
  return origins;
}

const allowedOriginsSet = collectAllowedOrigins();

const corsOriginResolver = (origin, callback) => {
  if (!origin) {
    return callback(null, true);
  }
  if (env.corsOrigins === '*') {
    return callback(null, origin);
  }
  if (allowedOriginsSet.has(origin)) {
    return callback(null, origin);
  }
  if (env.isDevelopment && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return callback(null, origin);
  }
  logger.warn(`CORS blocked request from origin: ${origin}`);
  return callback(null, false);
};

app.use(
  helmet({
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(
  cors({
    origin: corsOriginResolver,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
  })
);

// Provide permissive COOP for Google OAuth popups
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  next();
});

const requestBodyLimit = process.env.REQUEST_BODY_LIMIT || '25mb';
app.use(express.json({ limit: requestBodyLimit }));
app.use(express.urlencoded({ extended: true }));

// HTTP request logging
app.use(morgan(env.isProduction ? 'combined' : 'dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

// Rate limiting (global)
app.use(defaultLimiter);

// ─── Health Check & Favicon (no auth) ───────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ignore favicon requests from browser testing
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ─── Public Routes (no auth required) ───────────────────────────────────────
app.use('/auth', authRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/demo', demoAiRoutes);
app.use('/api/payment/webhook', paymentWebhookRoutes);
app.use('/webhooks', webhookRoutes);

app.get('/debug-campaigns-gcp', async (req, res) => {
  const db = require('./config/db');
  try {
    const { rows } = await db.query('SELECT id, name, project_id FROM campaigns ORDER BY created_at DESC LIMIT 10');
    res.json(rows);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ─── Protected Routes (auth required) ───────────────────────────────────────
app.use('/users', authMiddleware, usersRoutes);
app.use('/sales', authMiddleware, requireModuleAccess('sales'), salesRoutes);
app.use('/marketing', authMiddleware, requireModuleAccess('marketing'), marketingRoutes);
app.use('/api/marketing', authMiddleware, requireModuleAccess('marketing'), marketingRoutes); // New mount for exact path requested
app.use('/social', authMiddleware, requireModuleAccess('marketing'), socialRoutes);
app.use('/support', authMiddleware, requireModuleAccess('support'), supportRoutes);
app.use('/analytics', authMiddleware, analyticsRoutes);
app.use('/billing', authMiddleware, billingRoutes);
app.use('/projects', authMiddleware, projectsRoutes);
app.use('/ai', authMiddleware, aiRoutes);
app.use('/post-sales', authMiddleware, requireModuleAccess('post-sales'), postSalesRoutes);

// New Mounts
app.use('/orgs', authMiddleware, orgsRoutes);
app.use('/sales/campaigns', authMiddleware, salesCampaignsRoutes);
app.use('/sales/leads', authMiddleware, salesCampaignsRoutes); // Handles /sales/leads/upload/...
app.use('/integrations', authMiddleware, integrationsRoutes);
app.use('/subscriptions', authMiddleware, subscriptionsRoutes);
app.use('/credits', authMiddleware, creditsRoutes);
app.use('/notifications', authMiddleware, notificationsRoutes);
app.use('/admin', authMiddleware, adminRoutes);
app.use('/utils', authMiddleware, utilsRoutes);

// Specific API routes must come BEFORE generic /api route
app.use('/api/payment', authMiddleware, paymentRoutes);
app.use('/api/invoices', authMiddleware, invoiceRoutes);
app.use('/api/invoice', authMiddleware, invoiceRoutes); // Also support singular for backward compatibility
app.use('/api', testImageRoute); // Generic /api route last

// ─── 404 Handler ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.originalUrl} not found` },
  });
});

// ─── Global Error Handler ───────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
