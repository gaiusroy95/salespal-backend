const db = require('../config/db');
const logger = require('../config/logger');

/**
 * Valid product types and their display names.
 * This maps the productType keys used in payment requests
 * to the keys stored in platform_settings → module_pricing.
 */
const PRODUCT_DISPLAY_NAMES = {
  marketing: 'Marketing',
  sales: 'Sales',
  'post-sales': 'Post-Sales',
  support: 'Support',
  'salespal-360': 'SalesPal 360',
};

/**
 * Fetch product pricing from the database (admin-controlled).
 *
 * Reads from `platform_settings` where key = 'module_pricing'.
 * This is the same store the admin panel writes to via
 * PUT /api/admin/module-pricing/:module.
 *
 * @param {string} productType – e.g. "marketing", "sales", "post-sales", "support", "salespal-360"
 * @returns {Promise<{ name: string, monthlyPrice: number, yearlyPrice: number }>}
 * @throws {Error} with statusCode 400 if product not found or disabled
 * @throws {Error} with statusCode 503 if DB is unreachable
 */
async function getProductPrice(productType) {
  // Validate product type
  const displayName = PRODUCT_DISPLAY_NAMES[productType];
  if (!displayName) {
    const err = new Error(
      `Unknown productType "${productType}". Valid types: ${Object.keys(PRODUCT_DISPLAY_NAMES).join(', ')}`
    );
    err.statusCode = 400;
    err.code = 'INVALID_PRODUCT';
    throw err;
  }

  let result;
  try {
    result = await db.query(
      "SELECT value FROM platform_settings WHERE key = 'module_pricing'"
    );
  } catch (dbErr) {
    logger.error(`[pricingService] DB error fetching pricing: ${dbErr.message}`);
    const err = new Error('Unable to fetch pricing from database');
    err.statusCode = 503;
    err.code = 'PRICING_DB_ERROR';
    throw err;
  }

  const allPricing = result.rows[0]?.value;
  if (!allPricing || !allPricing[productType]) {
    const err = new Error(
      `Pricing not configured for "${productType}". Please set pricing in the admin panel.`
    );
    err.statusCode = 400;
    err.code = 'PRICING_NOT_FOUND';
    throw err;
  }

  const modulePricing = allPricing[productType];

  // Check if module is disabled by admin
  if (modulePricing.enabled === false) {
    const err = new Error(
      `Module "${productType}" is currently disabled. Purchase is not available.`
    );
    err.statusCode = 400;
    err.code = 'MODULE_DISABLED';
    throw err;
  }

  const monthlyPrice = Number(modulePricing.monthly) || 0;
  const yearlyPrice = Number(modulePricing.yearly) || 0;

  logger.info(
    `[pricingService] Fetched DB pricing: product=${productType} ` +
    `monthly=₹${monthlyPrice} yearly=₹${yearlyPrice}`
  );

  return {
    name: displayName,
    monthlyPrice,
    yearlyPrice,
  };
}

module.exports = { getProductPrice };
