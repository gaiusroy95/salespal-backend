const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');

/**
 * JWT authentication middleware.
 * Extracts and verifies the access token from Authorization: Bearer <token>.
 * Sets req.user = { id, email, role } on success.
 */
async function authMiddleware(req, res, next) {
  try {
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
      // Always use current DB role so promoted admins need not re-login for bypasses.
      try {
        const { rows } = await db.query(`SELECT email, role FROM users WHERE id = $1 LIMIT 1`, [decoded.sub]);
        if (rows[0]) {
          req.user.email = rows[0].email || req.user.email;
          req.user.role = rows[0].role || req.user.role;
        }
      } catch {
        /* keep JWT claims if DB lookup fails */
      }
      return next();
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
  } catch (err) {
    return next(err);
  }
}

/**
 * Optional auth middleware — sets req.user if token is present but does not
 * block the request if absent.
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, env.jwt.accessSecret);
    req.user = { id: decoded.sub, email: decoded.email, role: decoded.role };
    try {
      const { rows } = await db.query(`SELECT email, role FROM users WHERE id = $1 LIMIT 1`, [decoded.sub]);
      if (rows[0]) {
        req.user.email = rows[0].email || req.user.email;
        req.user.role = rows[0].role || req.user.role;
      }
    } catch {
      /* keep JWT claims */
    }
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
