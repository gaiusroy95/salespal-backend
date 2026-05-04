const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getInstance: getRazorpay } = require('../utils/razorpay');
const { getProductPrice } = require('../services/pricingService');
const { generateInvoice } = require('../utils/generateInvoice');
const db = require('../config/db');
const logger = require('../config/logger');
const billingService = require('../services/billing.service');
const { normalizeModuleKey, expandBundle } = require('../utils/moduleKeys');

/**
 * POST /api/payment/create-order
 *
 * Body: { productType: "marketing" | "sales" | ..., billingCycle?: "monthly" | "yearly" }
 *
 * - Price is fetched from the database (admin-controlled via Settings panel).
 * - Frontend values are never trusted for pricing.
 * - Returns the Razorpay order object so the frontend can open the checkout.
 */
router.post('/create-order', async (req, res, next) => {
  try {
    const { items, productType, billingCycle = 'monthly' } = req.body;

    // ── Build items ───────────────────────────────────────────────────────
    let orderItems = [];
    if (items && Array.isArray(items) && items.length > 0) {
      orderItems = items;
    } else if (productType && typeof productType === 'string') {
      orderItems = [{ productType, billingCycle }];
    } else {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'items array or productType is required' },
      });
    }

    let totalAmount = 0;
    const itemNotes = [];

    // ── Calculate Total Dynamic Pricing ────────────────────────────────────
    for (const item of orderItems) {
      if (!item.productType) continue;

      let pKey = normalizeModuleKey(item.productType);
      
      const cycle = item.billingCycle || billingCycle || 'monthly';
      const quantity = item.quantity || 1;

      try {
        const pricing = await getProductPrice(pKey);
        const cycleAmount = cycle === 'yearly' ? pricing.yearlyPrice : pricing.monthlyPrice;

        if (cycleAmount && cycleAmount > 0) {
          totalAmount += cycleAmount * quantity;
          itemNotes.push(`${pKey}(${cycle})x${quantity}`);
          
          logger.info(
            `[Payment] Item processed: product=${pKey} name=${pricing.name} ` +
            `cycle=${cycle} amount=₹${cycleAmount} qty=${quantity}`
          );
        } else {
            logger.warn(`[Payment] Invalid dynamic price parsed for ${pKey}`);
        }
      } catch (err) {
        // "If invalid productType -> skip or error"
        logger.warn(`[Payment] Skipping item ${pKey}: ${err.message}`);
        // Optionally handle 'credits' if the backend wanted to accept flat rates, but 
        // the strict security model skips anything not in pricing DB.
      }
    }

    if (totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PRICE',
          message: 'No valid priced items were configured for checkout.',
        },
      });
    }

    const amountInPaise = totalAmount * 100; // Razorpay expects paise

    // ── Create Razorpay order ────────────────────────────────────────────
    const order = await getRazorpay().orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: {
        items: itemNotes.join(', '),
        userId: req.user?.id || 'unknown',
      },
    });

    logger.info(
      `[Payment] Razorpay order created: orderId=${order.id} items=[${itemNotes.join(', ')}] ` +
      `total=₹${totalAmount} (${amountInPaise} paise) userId=${req.user?.id}`
    );

    return res.json({
      success: true,
      order,
      totalAmount,
      key: process.env.RAZORPAY_KEY_ID, // frontend needs this to open checkout
    });
  } catch (err) {
    // Surface known errors with their status code
    const statusCode = err.statusCode || 500;
    if (statusCode < 500) {
      return res.status(statusCode).json({
        success: false,
        error: { code: err.code || 'PAYMENT_ERROR', message: err.message },
      });
    }
    logger.error(`[Payment] Order creation failed: ${err.message}`);
    next(err);
  }
});

/**
 * POST /api/payment/verify
 *
 * Body: { razorpay_payment_id, razorpay_order_id, razorpay_signature }
 *
 * Validates the payment signature using HMAC-SHA256 to ensure
 * the payment was not tampered with or faked.
 */
router.post('/verify', async (req, res, next) => {
  try {
    const { items = [], billingCycle = 'monthly', razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    // ── Validate input ────────────────────────────────────────────────────
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: razorpay_payment_id, razorpay_order_id, razorpay_signature',
      });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
      logger.error('RAZORPAY_KEY_SECRET not configured — cannot verify payment');
      return res.status(503).json({
        success: false,
        message: 'Payment verification is not configured',
      });
    }

    // ── Generate expected signature ───────────────────────────────────────
    const generatedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    // ── Compare ───────────────────────────────────────────────────────────
    const isValid = crypto.timingSafeEqual(
      Buffer.from(generatedSignature, 'hex'),
      Buffer.from(razorpay_signature, 'hex')
    );

    if (isValid) {
      // ── Recalculate Total (IMPORTANT) ────────────────────────────────────
      const userId = req.user?.id || null;
      let totalAmount = 0;

      for (const item of items) {
        if (!item.productType) continue;

        let pKey = normalizeModuleKey(item.productType);
        
        try {
          const pricing = await getProductPrice(pKey);
          const cycleAmount = billingCycle === 'yearly' ? pricing.yearlyPrice : pricing.monthlyPrice;
          
          if (cycleAmount && cycleAmount > 0) {
            totalAmount += cycleAmount * (item.quantity || 1);
          }
        } catch (err) {
          logger.warn(`[Payment] Verification sum skipped item ${pKey}: ${err.message}`);
        }
      }

      // ── Insert into Database ─────────────────────────────────────────────
      try {
        const duplicate = await db.query(
          `SELECT id, invoice_number FROM payments WHERE razorpay_payment_id = $1 LIMIT 1`,
          [razorpay_payment_id]
        );
        if (duplicate.rows[0]) {
          return res.json({
            success: true,
            deduped: true,
            paymentId: duplicate.rows[0].id,
            invoiceNumber: duplicate.rows[0].invoice_number,
            orderId: razorpay_order_id,
          });
        }
        // Generate invoice number
        const yearMonth = new Date().getFullYear().toString().slice(-2) + String(new Date().getMonth() + 1).padStart(2, '0');
        const timestamp = Date.now().toString().slice(-6);
        const invoiceNumber = `INV-${yearMonth}-${timestamp}`;

        const query = `
          INSERT INTO payments (
            user_id,
            items,
            total_amount,
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
            status,
            invoice_number
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id;
        `;
        const values = [
          userId,
          JSON.stringify(items),
          totalAmount,
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
          "paid",
          invoiceNumber
        ];

        const result = await db.query(query, values);
        const paymentId = result.rows[0].id;

        // Activate subscriptions for purchased items.
        const orgRes = userId ? await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]) : { rows: [] };
        const orgId = orgRes.rows[0]?.org_id || null;
        if (userId && orgId) {
          const mods = new Set();
          for (const item of items || []) {
            for (const mk of expandBundle(item.productType)) mods.add(mk);
          }
          for (const mod of mods) {
            await billingService.activateSubscription(userId, orgId, mod);
          }
        }

        logger.info(
          `[Payment] Verified & Stored: dbId=${paymentId} invoiceNumber=${invoiceNumber} orderId=${razorpay_order_id} totalAmount=${totalAmount} userId=${userId}`
        );

        return res.json({
          success: true,
          paymentId,
          invoiceNumber,
          orderId: razorpay_order_id,
        });
      } catch (dbErr) {
        logger.error(`[Payment] DB insert failed after passing signature validation: ${dbErr.message}`);
        return res.status(500).json({
          success: false,
          error: { code: 'DB_INSERT_FAILED', message: 'Failed to record validated payment into database' }
        });
      }
    } else {
      logger.warn(
        `Payment verification FAILED (signature mismatch): orderId=${razorpay_order_id} paymentId=${razorpay_payment_id} userId=${req.user?.id}`
      );

      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature — verification failed',
      });
    }
  } catch (err) {
    logger.error(`Payment verification error: ${err.message}`);
    next(err);
  }
});

/**
 * GET /api/payment/invoice/:paymentId
 * 
 * Generates and downloads a dynamic PDF invoice for a validated 
 * Postgres payment record via stream piping.
 */
router.get('/invoice/:paymentId', async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const userId = req.user?.id;

    logger.info(`[Payment] Generating invoice PDF: paymentId=${paymentId}, userId=${userId}`);

    let result = { rows: [] };

    // Check if ID is an invoice number (starts with INV-)
    if (paymentId.startsWith('INV-')) {
      result = await db.query('SELECT * FROM payments WHERE invoice_number = $1', [paymentId]);
    } else {
      // Otherwise try as UUID
      try {
        result = await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
      } catch (err) {
        // If UUID parsing fails, try razorpay IDs
        result = await db.query('SELECT * FROM payments WHERE razorpay_payment_id = $1 OR razorpay_order_id = $1', [paymentId]);
      }
    }

    if (result.rows.length === 0) {
      logger.warn(`[Payment] Invoice not found: paymentId=${paymentId}`);
      return res.status(404).json({
        success: false,
        message: 'Payment invoice not found',
      });
    }

    const payment = result.rows[0];

    // Verify user owns this payment (if user_id is set)
    if (payment.user_id && userId && payment.user_id !== userId) {
      logger.warn(`[Payment] Unauthorized invoice access: paymentId=${paymentId} paymentUserId=${payment.user_id} requestUserId=${userId}`);
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You do not have access to this invoice',
      });
    }

    // Determine correct headers per specifications
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=invoice_${payment.invoice_number || paymentId}.pdf`
    );

    // Generate output streaming to res iteratively 
    generateInvoice(res, payment);

  } catch (err) {
    logger.error(`[Payment] Failed to generate invoice pdf ${req.params?.paymentId}: ${err.message}`);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: 'Error generating invoice pdf document'
      });
    }
  }
});

/**
 * GET /api/payment/:paymentId
 * 
 * Fetches payment details by ID (JSON response, not PDF)
 * Used by InvoicePage to display invoice with actual data
 */
router.get('/:paymentId', async (req, res, next) => {
  try {
    const { paymentId } = req.params;
    const userId = req.user?.id;

    logger.info(`[Payment] Fetching payment details: paymentId=${paymentId}, userId=${userId}`);

    let result = { rows: [] };

    // Check if ID is an invoice number (starts with INV-)
    if (paymentId.startsWith('INV-')) {
      result = await db.query('SELECT * FROM payments WHERE invoice_number = $1', [paymentId]);
    } else {
      // Otherwise try as UUID
      try {
        result = await db.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
      } catch (err) {
        // If UUID parsing fails, try razorpay IDs
        result = await db.query('SELECT * FROM payments WHERE razorpay_payment_id = $1 OR razorpay_order_id = $1', [paymentId]);
      }
    }

    if (result.rows.length === 0) {
      logger.warn(`[Payment] Payment not found: paymentId=${paymentId}`);
      return res.status(404).json({
        success: false,
        message: 'Payment not found',
      });
    }

    const payment = result.rows[0];

    // Verify user owns this payment (if user_id is set)
    if (payment.user_id && userId && payment.user_id !== userId) {
      logger.warn(`[Payment] Unauthorized access attempt: paymentId=${paymentId} paymentUserId=${payment.user_id} requestUserId=${userId}`);
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You do not have access to this payment',
      });
    }

    logger.info(`[Payment] Successfully fetched payment: paymentId=${paymentId}`);

    return res.json({
      success: true,
      payment: {
        id: payment.id,
        invoice_number: payment.invoice_number,
        amount: payment.total_amount,
        items: payment.items,
        status: payment.status || 'PAID',
        method: 'Razorpay / Card',
        date: payment.created_at ? new Date(payment.created_at).toLocaleString() : new Date().toLocaleString(),
        transactionId: payment.razorpay_payment_id || payment.id,
      }
    });

  } catch (err) {
    logger.error(`[Payment] Failed to fetch payment details for ${req.params?.paymentId}: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'Error fetching payment details'
    });
  }
});

module.exports = router;
