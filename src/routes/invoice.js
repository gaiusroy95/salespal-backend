const express = require('express');
const router = express.Router();
const db = require('../config/db');
const logger = require('../config/logger');
const { generateInvoice } = require('../utils/generateInvoice');

/**
 * GET /api/invoices
 * 
 * Fetches all invoices for the authenticated user
 * Returns: Array of invoices sorted by created_at DESC
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      logger.warn('[Invoice] Unauthorized access attempt: No user ID');
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
    }

    logger.info(`[Invoice] Fetching all invoices for userId=${userId}`);

    const query = `
      SELECT 
        id,
        invoice_number,
        total_amount as amount,
        status,
        items,
        razorpay_payment_id,
        created_at
      FROM payments
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const result = await db.query(query, [userId]);

    const invoices = result.rows.map((payment, index) => ({
      id: payment.id,
      invoiceNumber: payment.invoice_number,
      amount: parseFloat(payment.amount),
      status: payment.status || 'PAID',
      pdfUrl: `/api/invoice/${payment.invoice_number || payment.id}/download`,
      date: new Date(payment.created_at).toISOString().split('T')[0],
      createdAt: payment.created_at,
      transactionId: payment.razorpay_payment_id || payment.id,
      isLatest: index === 0, // Mark the first (most recent) as latest
    }));

    logger.info(`[Invoice] Retrieved ${invoices.length} invoices for userId=${userId}`);

    return res.json({
      success: true,
      count: invoices.length,
      invoices,
    });

  } catch (err) {
    logger.error(`[Invoice] Failed to fetch invoices: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'Error fetching invoices',
    });
  }
});

/**
 * GET /api/invoice/:id/download
 * 
 * Downloads invoice as PDF
 * Accepts: UUID, invoice_number, razorpay_payment_id, razorpay_order_id
 * Returns: PDF file with attachment header
 */
router.get('/:id/download', async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    logger.info(`[Invoice] Download request: id=${id}, userId=${userId}`);

    let result = { rows: [] };

    // Check if ID is an invoice number (starts with INV-)
    if (id.startsWith('INV-')) {
      result = await db.query('SELECT * FROM payments WHERE invoice_number = $1', [id]);
    } else {
      // Otherwise try as UUID
      try {
        result = await db.query('SELECT * FROM payments WHERE id = $1', [id]);
      } catch (err) {
        // If UUID parsing fails, try razorpay IDs
        result = await db.query('SELECT * FROM payments WHERE razorpay_payment_id = $1 OR razorpay_order_id = $1', [id]);
      }
    }

    if (result.rows.length === 0) {
      logger.warn(`[Invoice] Invoice not found: id=${id}`);
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    const payment = result.rows[0];

    // Verify user owns this invoice (if user_id is set)
    if (payment.user_id && userId && payment.user_id !== userId) {
      logger.warn(`[Invoice] Unauthorized download attempt: id=${id} paymentUserId=${payment.user_id} requestUserId=${userId}`);
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You do not have access to this invoice',
      });
    }

    // Set response headers for PDF download
    const invoiceFilename = `SalesPal_Invoice_${payment.invoice_number || payment.id}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoiceFilename}.pdf"`);

    logger.info(`[Invoice] Generating PDF: invoiceNumber=${payment.invoice_number}, filename=${invoiceFilename}.pdf`);

    // Generate and stream PDF
    generateInvoice(res, payment);

  } catch (err) {
    logger.error(`[Invoice] Download failed for ${req.params?.id}: ${err.message}`);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: 'Error generating invoice PDF',
      });
    }
  }
});

/**
 * GET /api/invoice/:id
 * 
 * Fetches invoice details as JSON
 * Accepts: UUID, invoice_number, razorpay_payment_id, razorpay_order_id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    logger.info(`[Invoice] Fetch details: id=${id}, userId=${userId}`);

    let result = { rows: [] };

    // Check if ID is an invoice number (starts with INV-)
    if (id.startsWith('INV-')) {
      result = await db.query('SELECT * FROM payments WHERE invoice_number = $1', [id]);
    } else {
      // Otherwise try as UUID
      try {
        result = await db.query('SELECT * FROM payments WHERE id = $1', [id]);
      } catch (err) {
        // If UUID parsing fails, try razorpay IDs
        result = await db.query('SELECT * FROM payments WHERE razorpay_payment_id = $1 OR razorpay_order_id = $1', [id]);
      }
    }

    if (result.rows.length === 0) {
      logger.warn(`[Invoice] Invoice not found: id=${id}`);
      return res.status(404).json({
        success: false,
        message: 'Invoice not found',
      });
    }

    const payment = result.rows[0];

    // Verify user owns this invoice (if user_id is set)
    if (payment.user_id && userId && payment.user_id !== userId) {
      logger.warn(`[Invoice] Unauthorized access: id=${id} paymentUserId=${payment.user_id} requestUserId=${userId}`);
      return res.status(403).json({
        success: false,
        message: 'Unauthorized: You do not have access to this invoice',
      });
    }

    logger.info(`[Invoice] Successfully fetched details: id=${id}`);

    return res.json({
      success: true,
      invoice: {
        id: payment.id,
        invoiceNumber: payment.invoice_number,
        amount: payment.total_amount,
        items: payment.items,
        status: payment.status || 'PAID',
        method: 'Razorpay',
        date: payment.created_at ? new Date(payment.created_at).toLocaleString() : new Date().toLocaleString(),
        transactionId: payment.razorpay_payment_id || payment.id,
      }
    });

  } catch (err) {
    logger.error(`[Invoice] Fetch failed for ${req.params?.id}: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: 'Error fetching invoice details'
    });
  }
});

module.exports = router;
