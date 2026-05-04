/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  DEPRECATED — This file is no longer used.                              ║
 * ║                                                                         ║
 * ║  Pricing is now fetched dynamically from the database via:              ║
 * ║    services/pricingService.js → getProductPrice(productType)            ║
 * ║                                                                         ║
 * ║  Admin panel controls pricing at:                                       ║
 * ║    GET  /api/admin/module-pricing                                       ║
 * ║    PUT  /api/admin/module-pricing/:module                               ║
 * ║                                                                         ║
 * ║  This file is kept temporarily to avoid breaking any unknown imports.   ║
 * ║  Safe to delete once confirmed no other code references it.             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

const logger = require('../config/logger');

const PRICE_MAP = {}; // Intentionally empty — pricing now lives in the DB

function getFinalAmount(/* productType */) {
  const err = new Error(
    'pricing.js is deprecated. Use pricingService.getProductPrice() instead. ' +
    'Pricing is now managed from the admin panel.'
  );
  err.statusCode = 500;
  err.code = 'DEPRECATED';
  logger.error('[pricing.js] DEPRECATED call to getFinalAmount — migrate to pricingService.js');
  throw err;
}

module.exports = { getFinalAmount, PRICE_MAP };
