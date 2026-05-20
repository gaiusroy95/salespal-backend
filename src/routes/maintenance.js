const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../config/logger');
const { DEFAULT_MAINTENANCE, parseSettingsValue } = require('../utils/publicApiFallbacks');

/**
 * GET /api/maintenance/status
 *
 * Public endpoint — no auth required.
 * Returns maintenance mode state so even unauthenticated users
 * can see the maintenance page.
 */
router.get('/status', async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'platform_config'"
    );

    const config = parseSettingsValue(result.rows[0]?.value);

    // Build a clean maintenance response
    const maintenance = config.maintenance || {
      global: { enabled: false, reason: '', eta: '' },
      modules: {
        marketing: { enabled: false, reason: '', eta: '' },
        sales: { enabled: false, reason: '', eta: '' },
        'post-sales': { enabled: false, reason: '', eta: '' },
        support: { enabled: false, reason: '', eta: '' },
      },
    };

    // Backward compat: if old maintenance_mode boolean was used
    if (config.maintenance_mode && !maintenance.global?.enabled) {
      maintenance.global = {
        ...maintenance.global,
        enabled: true,
        reason: 'Scheduled maintenance',
        eta: '',
      };
    }

    res.json({ maintenance });
  } catch (err) {
    logger.error(`[Maintenance API] Failed to fetch status: ${err.message}`);
    return res.json({ maintenance: DEFAULT_MAINTENANCE, degraded: true });
  }
});

module.exports = router;
