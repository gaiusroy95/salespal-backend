const app = require('./src/app');
const env = require('./src/config/env');
const logger = require('./src/config/logger');
const db = require('./src/config/db');

const server = app.listen(env.PORT, () => {
  logger.info(`🚀 SalesPal API server running on port ${env.PORT}`);
  logger.info(`   Environment: ${env.NODE_ENV}`);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
const shutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);

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
