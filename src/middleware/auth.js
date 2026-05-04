const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * JWT authentication middleware.
 * Extracts and verifies the access token from Authorization: Bearer <token>.
 * Sets req.user = { id, email, role } on success.
 */
function authMiddleware(req, res, next) {
  // Browsers send OPTIONS preflight without Authorization; must not 401 before CORS completes.
  if (req.method === 'OPTIONS') {
    return next();
  }

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid Authorization header',
      },
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: {
          code: 'TOKEN_EXPIRED',
          message: 'Access token has expired. Please refresh.',
        },
      });
    }
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid access token',
      },
    });
  }
}

/**
 * Optional auth middleware — sets req.user if token is present but does not
 * block the request if absent.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
  } catch {
    req.user = null;
  }
  next();
}

/**
 * Role-based access control middleware factory.
 * @param  {...string} roles — Allowed roles
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Insufficient permissions' },
      });
    }
    next();
  };
}

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return next({ status: 403, code: 'FORBIDDEN', message: 'Admin access required' });
  }
  next();
};

module.exports = { 
  authMiddleware, 
  optionalAuth, 
  requireRole, 
  requireAuth: authMiddleware, 
  requireAdmin 
};
