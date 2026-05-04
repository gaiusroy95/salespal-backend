const db = require('../config/db');
const { normalizeModuleKey } = require('../utils/moduleKeys');
const env = require('../config/env');

function requireModuleAccess(moduleName) {
  const moduleKey = normalizeModuleKey(moduleName);
  return async (req, res, next) => {
    try {
      // Admins bypass subscription checks in development/operations.
      if (req.user?.role === 'admin') {
        return next();
      }
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      }
      // NOTE: we intentionally do NOT globally bypass checks via DISABLE_SUBSCRIPTIONS
      // for non-admin users, so payment/subscription logic remains active.
      if (env.subscriptions?.disabled) {
        // Keep behavior explicit in logs while still enforcing checks below.
        // eslint-disable-next-line no-console
        console.warn('[entitlements] DISABLE_SUBSCRIPTIONS is set, but non-admin checks remain enforced.');
      }
      const { rows } = await db.query(
        `SELECT status
         FROM subscriptions
         WHERE user_id = $1
           AND module IN ($2, 'salespal-360')
         ORDER BY CASE WHEN module = 'salespal-360' THEN 0 ELSE 1 END
         LIMIT 1`,
        [userId, moduleKey]
      );
      const active = rows[0] && (rows[0].status === 'active' || rows[0].status === 'trial');
      if (!active) {
        return res.status(402).json({
          error: {
            code: 'SUBSCRIPTION_REQUIRED',
            message: `Active subscription required for ${moduleKey}`,
          },
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireModuleAccess };
