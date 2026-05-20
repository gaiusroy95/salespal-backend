const db = require('../config/db');
const billingService = require('../services/billing.service');

async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

async function getSubscriptions(req, res, next) {
  try {
    const subs = await billingService.getUserSubscriptions(req.user.id);
    res.json(subs);
  } catch (err) {
    next(err);
  }
}

async function activateSubscription(req, res, next) {
  try {
    const { moduleId } = req.body;
    if (!moduleId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'moduleId is required' } });

    const orgId = await getOrgId(req.user.id);
    const result = await billingService.activateSubscription(req.user.id, orgId, moduleId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function deactivateSubscription(req, res, next) {
  try {
    const result = await billingService.deactivateSubscription(req.user.id, req.params.moduleId);
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function pauseSubscription(req, res, next) {
  try {
    const result = await billingService.pauseSubscription(req.user.id, req.params.moduleId);
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function resumeSubscription(req, res, next) {
  try {
    const result = await billingService.resumeSubscription(req.user.id, req.params.moduleId);
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Subscription not found' } });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getCredits(req, res, next) {
  try {
    if (req.user?.role === 'admin') {
      const orgId = await getOrgId(req.user.id);
      const balance = orgId ? await billingService.getCreditBalance(orgId) : 0;
      return res.json({ balance: Math.max(balance, 999999), bypassed: true, reason: 'admin_credit_bypass' });
    }
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ balance: 0 });
    const balance = await billingService.getCreditBalance(orgId);
    res.json({ balance });
  } catch (err) {
    next(err);
  }
}

async function consumeCredit(req, res, next) {
  try {
    if (req.user?.role === 'admin') {
      const orgId = await getOrgId(req.user.id);
      const balance = orgId ? await billingService.getCreditBalance(orgId) : 0;
      return res.json({ success: true, balance, bypassed: true, reason: 'admin_credit_bypass' });
    }
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { type, amount } = req.body;
    const success = await billingService.consumeCredit(orgId, type, amount || 1);
    res.json({ success });
  } catch (err) {
    next(err);
  }
}

async function addCredits(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { amount, source } = req.body;
    const newBalance = await billingService.addCredits(orgId, amount, source || 'topup');
    res.json({ balance: newBalance });
  } catch (err) {
    next(err);
  }
}

async function getCreditTransactions(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);
    const transactions = await billingService.getCreditTransactions(orgId, parseInt(req.query.limit) || 50);
    res.json(transactions);
  } catch (err) {
    next(err);
  }
}

async function getPlans(req, res, next) {
  try {
    res.json(billingService.MODULES);
  } catch (err) {
    next(err);
  }
}

module.exports = { getSubscriptions, activateSubscription, deactivateSubscription, pauseSubscription, resumeSubscription, getCredits, consumeCredit, addCredits, getCreditTransactions, getPlans };
