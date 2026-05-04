const express = require('express');
const router = express.Router();
const { getProductPrice } = require('../services/pricingService');
const logger = require('../config/logger');
const db = require('../config/db');

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
    result.rows.forEach(row => {
      if (row.key === 'module_pricing') allPricing = row.value || {};
      if (row.key === 'platform_config') platformConfig = row.value || {};
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

    logger.info(`[Pricing API] Served ${pricing.length} module pricing entries. Maintenance: ${maintenanceMode}`);

    return res.json({ 
      pricing, 
      modules: moduleAccess,
      maintenanceMode
    });
  } catch (err) {
    logger.error(`[Pricing API] Failed to fetch pricing: ${err.message}`);
    next(err);
  }
});

module.exports = router;
