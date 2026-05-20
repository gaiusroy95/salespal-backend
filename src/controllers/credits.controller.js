const db = require('../config/db');
const creditService = require('../services/credit.service');

async function getOrgId(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

exports.getBalance = async (req, res, next) => {
  try {
    if (req.user?.role === 'admin') {
      const orgId = await getOrgId(req.user.id);
      const balance = orgId ? await creditService.getBalance(orgId) : 0;
      return res.json({ balance: Math.max(balance, 999999), bypassed: true, reason: 'admin_credit_bypass' });
    }
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ balance: 0 });
    const balance = await creditService.getBalance(orgId);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
};

exports.consumeCredits = async (req, res, next) => {
  try {
    if (req.user?.role === 'admin') {
      const orgId = await getOrgId(req.user.id);
      const balance = orgId ? await creditService.getBalance(orgId) : 0;
      return res.json({ success: true, balance, bypassed: true, reason: 'admin_credit_bypass' });
    }
    const { amount, type, description } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'amount must be positive' } });
    }
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    // consumeCredits(orgId, amount, type, description, userId)
    const success = await creditService.consumeCredits(
      orgId,
      amount,
      type || 'consume',
      description || null,
      req.user.id
    );

    if (!success) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credit balance' } });
    }

    const balance = await creditService.getBalance(orgId);
    res.json({ success: true, balance });
  } catch (err) {
    next(err);
  }
};

exports.addCredits = async (req, res, next) => {
  try {
    const { amount, source, description } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'amount must be positive' } });
    }
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    // addCredits(orgId, amount, source, description, userId)
    const newBalance = await creditService.addCredits(
      orgId,
      amount,
      source || 'topup',
      description || null,
      req.user.id
    );

    res.json({ success: true, balance: newBalance });
  } catch (err) {
    next(err);
  }
};

exports.getTransactions = async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ transactions: [] });

    const transactions = await creditService.getTransactions(orgId, { limit, offset });
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
};

exports.recordUsage = async (req, res, next) => {
  try {
    if (req.user?.role === 'admin') {
      const orgId = await getOrgId(req.user.id);
      const balance = orgId ? await creditService.getBalance(orgId) : 0;
      return res.json({ success: true, balance, bypassed: true, reason: 'admin_credit_bypass' });
    }
    const { channel, units = 1, description, referenceId } = req.body || {};
    if (!channel) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'channel is required' } });
    }
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const amount = Math.max(1, Number(units) || 1);
    const ok = await creditService.consumeCredits(
      orgId,
      amount,
      `usage_${String(channel).toLowerCase()}`,
      description || `Usage recorded for ${channel}`,
      req.user.id
    );
    if (!ok) {
      return res.status(402).json({ error: { code: 'INSUFFICIENT_CREDITS', message: 'Insufficient credit balance' } });
    }
    if (referenceId) {
      await db.query(
        `UPDATE credit_transactions
         SET reference_id = $1
         WHERE org_id = $2 AND user_id = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [referenceId, orgId, req.user.id]
      );
    }
    const balance = await creditService.getBalance(orgId);
    res.json({ success: true, balance });
  } catch (err) {
    next(err);
  }
};

exports.getUsageSummary = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ channels: {}, totalDebits: 0 });
    const { rows } = await db.query(
      `SELECT reference_type, SUM(amount)::INT AS units
       FROM credit_transactions
       WHERE org_id = $1 AND type = 'debit'
       GROUP BY reference_type`,
      [orgId]
    );
    const channels = {};
    let totalDebits = 0;
    for (const r of rows) {
      channels[r.reference_type] = Number(r.units || 0);
      totalDebits += Number(r.units || 0);
    }
    res.json({ channels, totalDebits });
  } catch (err) {
    next(err);
  }
};
