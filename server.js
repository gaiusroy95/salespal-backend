const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/config/logger');
const db = require('./src/config/db');
const salesController = require('./src/controllers/sales.controller');

const server = app.listen(env.PORT, () => {
  logger.info(`🚀 SalesPal API server running on port ${env.PORT}`);
  logger.info(`   Environment: ${env.NODE_ENV}`);
});

// ─── Background Sales Automation Dispatcher ───────────────────────────────────
let automationDispatchTimer = null;
let automationDispatchRunning = false;

async function dispatchDueAutomationForAllUsers() {
  if (automationDispatchRunning) return;
  automationDispatchRunning = true;
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT user_id
       FROM sales_automation_jobs
       WHERE status = 'pending'
         AND schedule_at <= NOW()
       ORDER BY user_id
       LIMIT 100`
    );
    for (const row of rows) {
      const userId = row?.user_id;
      if (!userId) continue;
      try {
        const req = { user: { id: userId }, body: { limit: 50 } };
        const res = { json: () => {} };
        await salesController.dispatchDueAutomationJobs(req, res, (err) => {
          if (err) throw err;
        });
      } catch (err) {
        logger.warn('[automation-dispatch] user dispatch failed', {
          userId,
          error: err?.message || 'Unknown error',
        });
      }
    }
  } catch (err) {
    logger.error('[automation-dispatch] poll failed', { error: err?.message || 'Unknown error' });
  } finally {
    automationDispatchRunning = false;
  }
}

function startAutomationDispatcher() {
  const enabled = String(process.env.SALES_AUTOMATION_DISPATCHER_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logger.info('[automation-dispatch] disabled by SALES_AUTOMATION_DISPATCHER_ENABLED=false');
    return;
  }
  dispatchDueAutomationForAllUsers().catch(() => {});
  automationDispatchTimer = setInterval(() => {
    dispatchDueAutomationForAllUsers().catch(() => {});
  }, 30000);
  logger.info('[automation-dispatch] started (interval=30s)');
}

startAutomationDispatcher();

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  if (automationDispatchTimer) {
    clearInterval(automationDispatchTimer);
    automationDispatchTimer = null;
  }

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Close database connection pool
      await db.close();
      logger.info('Database connection pool closed');
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
    }

    process.exit(0);
  });

  // Force exit after 30 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error('Forceful shutdown — could not close connections in time');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason: reason?.message || reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
