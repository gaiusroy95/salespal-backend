const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const logger = require('../config/logger');
const { expandBundle, normalizeModuleKey } = require('../utils/moduleKeys');
const billingService = require('../services/billing.service');

const router = express.Router();

router.post('/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    if (!signature || !secret) return res.status(400).json({ ok: false, message: 'Invalid webhook configuration' });

    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (expected !== signature) return res.status(401).json({ ok: false, message: 'Invalid webhook signature' });

    const payload = JSON.parse(req.body.toString('utf8'));
    const eventId = payload?.payload?.payment?.entity?.id || payload?.event + ':' + (payload?.created_at || Date.now());
    const eventType = String(payload?.event || '');

    await db.query(
      `CREATE TABLE IF NOT EXISTS payment_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id TEXT UNIQUE NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        processed_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );
    const inserted = await db.query(
      `INSERT INTO payment_webhook_events (event_id, event_type, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [eventId, eventType, payload]
    );
    if (!inserted.rows[0]) return res.json({ ok: true, deduped: true });

    if (eventType === 'payment.captured') {
      const entity = payload?.payload?.payment?.entity || {};
      const notes = payload?.payload?.order?.entity?.notes || {};
      const userId = notes.userId || null;
      const orgIdRes = userId ? await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]) : { rows: [] };
      const orgId = orgIdRes.rows[0]?.org_id || null;
      const items = String(notes.items || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .map((chunk) => normalizeModuleKey(chunk.split('(')[0]));
      const activatedModules = new Set();
      for (const key of items) {
        if (!key || !userId || !orgId) continue;
        for (const mk of expandBundle(key)) {
          activatedModules.add(mk);
        }
      }
      if (userId && orgId && activatedModules.size) {
        for (const mod of activatedModules) {
          await billingService.activateSubscription(userId, orgId, mod);
        }
      }

      await db.query(
        `UPDATE payments
         SET status = 'paid', updated_at = NOW()
         WHERE razorpay_payment_id = $1 OR razorpay_order_id = $2`,
        [entity.id || null, entity.order_id || null]
      );
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error(`Webhook processing failed: ${err.message}`);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
