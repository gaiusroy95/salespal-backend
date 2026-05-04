const Razorpay = require('razorpay');
const logger = require('../config/logger');

let razorpay = null;

const keyId = process.env.RAZORPAY_KEY_ID || '';
const keySecret = process.env.RAZORPAY_KEY_SECRET || '';

if (!keyId || !keySecret || keyId.includes('YOUR_KEY') || keySecret.includes('YOUR_KEY')) {
  logger.warn('Razorpay keys not configured – payment features will fail at runtime');
} else {
  razorpay = new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
  logger.info('Razorpay initialized successfully');
}

/**
 * Returns the Razorpay instance, or throws if not configured.
 */
function getInstance() {
  if (!razorpay) {
    const err = new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env');
    err.statusCode = 503;
    throw err;
  }
  return razorpay;
}

module.exports = { getInstance };
