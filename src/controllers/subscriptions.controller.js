const db = require('../config/db');
const billingService = require('../services/billing.service');
const creditService = require('../services/credit.service');
const { normalizeModuleKey } = require('../utils/moduleKeys');

async function getOrgId(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

exports.listSubscriptions = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `SELECT * FROM subscriptions WHERE org_id = $1 ORDER BY activated_at DESC`,
      [orgId]
    );
    res.json({ subscriptions: rows });
  } catch (err) {
    next(err);
  }
};

exports.getSubscription = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `SELECT * FROM subscriptions WHERE org_id = $1 AND module = $2`,
      [orgId, req.params.module]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json({ subscription: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.activateSubscription = async (req, res, next) => {
  try {
    const { module, plan } = req.body;
    if (!module) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'module is required' } });
    const normalizedModule = normalizeModuleKey(module);

    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const results = await billingService.activateSubscription(req.user.id, orgId, normalizedModule);

    // If marketing module, ensure credits row exists
    if (normalizedModule === 'marketing' || normalizedModule === 'salespal-360') {
      await creditService.ensureCreditsRow(orgId, req.user.id);
    }

    res.json({ subscriptions: results });
  } catch (err) {
    next(err);
  }
};

exports.pauseSubscription = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `UPDATE subscriptions
       SET status = 'paused', paused_at = NOW(), updated_at = NOW()
       WHERE org_id = $1 AND module = $2
       RETURNING *`,
      [orgId, req.params.module]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json({ subscription: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.resumeSubscription = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `UPDATE subscriptions
       SET status = 'active', paused_at = NULL, updated_at = NOW()
       WHERE org_id = $1 AND module = $2
       RETURNING *`,
      [orgId, req.params.module]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json({ subscription: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.deactivateSubscription = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `UPDATE subscriptions
       SET status = 'inactive', cancelled_at = NOW(), updated_at = NOW()
       WHERE org_id = $1 AND module = $2
       RETURNING *`,
      [orgId, req.params.module]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json({ subscription: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.getCreditBalance = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ balance: 0 });

    const balance = await creditService.getBalance(orgId);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
};
