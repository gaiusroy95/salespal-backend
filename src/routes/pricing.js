const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const db = require('../config/db');
const {
  DEFAULT_PUBLIC_PRICING,
  DEFAULT_MODULE_ACCESS,
  parseSettingsValue,
} = require('../utils/publicApiFallbacks');

/**
 * GET /api/pricing
 *
 * Public endpoint — no auth required.
 * Returns all enabled module pricing from the database.
 * Used by homepage pricing section, checkout page, and any public-facing UI.
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      "SELECT key, value FROM platform_settings WHERE key IN ('module_pricing', 'platform_config')"
    );

    let allPricing = {};
    let platformConfig = {};
    result.rows.forEach((row) => {
      if (row.key === 'module_pricing') allPricing = parseSettingsValue(row.value);
      if (row.key === 'platform_config') platformConfig = parseSettingsValue(row.value);
    });

    const moduleAccess = platformConfig.modules || {
      marketing: true,
      sales: true,
      'post-sales': true,
      support: true
    };

    const maintenanceMode = platformConfig.maintenance_mode || false;

    // Build the response array from DB data
    const DISPLAY_NAMES = {
      marketing: 'Marketing',
      sales: 'Sales',
      'post-sales': 'Post-Sales',
      support: 'Support',
      'salespal-360': 'SalesPal 360',
    };

    const pricing = Object.entries(allPricing)
      .filter(([, data]) => data.enabled !== false) // Only return enabled module prices
      .map(([productType, data]) => ({
        productType,
        name: DISPLAY_NAMES[productType] || productType,
        monthlyPrice: Number(data.monthly) || 0,
        yearlyPrice: Number(data.yearly) || 0,
      }));

    const pricingOut = pricing.length ? pricing : DEFAULT_PUBLIC_PRICING;

    logger.info(`[Pricing API] Served ${pricingOut.length} module pricing entries. Maintenance: ${maintenanceMode}`);

    return res.json({
      pricing: pricingOut,
      modules: moduleAccess,
      maintenanceMode,
      degraded: !pricing.length,
    });
  } catch (err) {
    logger.error(`[Pricing API] Failed to fetch pricing: ${err.message}`);
    return res.json({
      pricing: DEFAULT_PUBLIC_PRICING,
      modules: DEFAULT_MODULE_ACCESS,
      maintenanceMode: false,
      degraded: true,
    });
  }
});

module.exports = router;
