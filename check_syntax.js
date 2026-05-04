// Syntax check — loads all modules to catch require/parse errors
// Run: node check_syntax.js
process.env.NODE_ENV = 'development';

const files = [
  './src/config/env',
  './src/config/db',
  './src/config/logger',
  './src/middleware/auth',
  './src/middleware/errorHandler',
  './src/middleware/rateLimiter',
  './src/middleware/upload',
  './src/middleware/validate',
  './src/services/auth.service',
  './src/services/org.service',
  './src/services/credit.service',
  './src/services/social.service',
  './src/services/billing.service',
  './src/services/analytics.service',
  './src/services/ai.service',
  './src/services/leadUpload.service',
  './src/services/websiteScraper.service',
  './src/controllers/auth.controller',
  './src/controllers/users.controller',
  './src/controllers/orgs.controller',
  './src/controllers/sales.controller',
  './src/controllers/salesCampaigns.controller',
  './src/controllers/marketing.controller',
  './src/controllers/social.controller',
  './src/controllers/post-sales.controller',
  './src/controllers/support.controller',
  './src/controllers/analytics.controller',
  './src/controllers/billing.controller',
  './src/controllers/credits.controller',
  './src/controllers/integrations.controller',
  './src/controllers/notifications.controller',
  './src/controllers/admin.controller',
  './src/controllers/projects.controller',
  './src/controllers/ai.controller',
  './src/controllers/subscriptions.controller',
  './src/controllers/utils.controller',
  './src/routes/auth',
  './src/routes/users',
  './src/routes/orgs',
  './src/routes/sales',
  './src/routes/salesCampaigns',
  './src/routes/marketing',
  './src/routes/social',
  './src/routes/post-sales',
  './src/routes/support',
  './src/routes/analytics',
  './src/routes/billing',
  './src/routes/credits',
  './src/routes/integrations',
  './src/routes/notifications',
  './src/routes/admin',
  './src/routes/projects',
  './src/routes/ai',
  './src/routes/subscriptions',
  './src/routes/utils',
  './src/app',
];

let passed = 0;
let failed = 0;

for (const f of files) {
  try {
    require(f);
    console.log(`  ✓ ${f}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${f}: ${e.message}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
