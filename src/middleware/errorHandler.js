const env = require('../config/env');
const logger = require('../config/logger');

/**
 * Global error handler middleware.
 * Returns structured JSON errors; never leaks stack traces in production.
 */
function errorHandler(err, req, res, _next) {
  // Determine status code
  const statusCode = err.statusCode || err.status || 500;

  // Determine error code
  const code = err.code || (statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR');

  // Log the error
  if (statusCode >= 500) {
    logger.error(`${code}: ${err.message}`, {
      statusCode,
      method: req.method,
      path: req.originalUrl,
      stack: err.stack,
    });
  } else {
    logger.warn(`${code}: ${err.message}`, {
      statusCode,
      method: req.method,
      path: req.originalUrl,
    });
  }

  // Build response
  const response = {
    error: {
      code,
      message: err.message || 'An unexpected error occurred',
    },
  };

  // Include details for validation errors
  if (err.details) {
    response.error.details = err.details;
  }

  // Include stack trace only in development
  if (!env.isProduction && err.stack) {
    response.error.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

module.exports = errorHandler;
