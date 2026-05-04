const db = require('../config/db');
const logger = require('../config/logger');
const { normalizeModuleKey, expandBundle } = require('../utils/moduleKeys');

/**
 * Module pricing and limits configuration (matches frontend commerce.config.js).
 */
const MODULES = {
  marketing:   { id: 'marketing',   name: 'Marketing',   price: 5999,  limits: { images: 20, videos: 4, posts: 30, calls: 500, whatsapp: 300 } },
  sales:       { id: 'sales',       name: 'Sales',       price: 9999 },
  postSale:    { id: 'postSale',    name: 'Post-Sales',  price: 9999 },
  support:     { id: 'support',     name: 'Support',     price: 9999 },
  salespal360: { id: 'salespal360', name: 'SalesPal 360', price: 29999, limits: { images: 100, videos: 20, posts: 150, calls: 1000, whatsapp: 500 } },
};

const MODULE_KEY_ALIASES = {
  postSale: 'post-sales',
  salespal360: 'salespal-360',
};

/**
 * Get all active subscriptions for a user.
 */
async function getUserSubscriptions(userId) {
  const { rows } = await db.query(
    `SELECT * FROM subscriptions WHERE user_id = $1`,
    [userId]
  );
  return rows;
}

/**
 * Get a specific subscription by user and module.
 */
async function getSubscription(userId, moduleId) {
  const moduleKey = normalizeModuleKey(moduleId);
  const { rows } = await db.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND module = $2`,
    [userId, moduleKey]
  );
  return rows[0] || null;
}

/**
 * Activate a subscription for a user.
 * Handles single modules and bundle (salespal360 activates all modules).
 * Uses UNIQUE(org_id, module) for ON CONFLICT.
 */
async function activateSubscription(userId, orgId, moduleId) {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const moduleIds = expandBundle(moduleId);

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const results = [];

    for (const modId of moduleIds) {
      const canonical = MODULE_KEY_ALIASES[modId] || modId;
      const { rows } = await client.query(
        `INSERT INTO subscriptions (user_id, org_id, module, status, plan, activated_at, expires_at)
         VALUES ($1, $2, $3, 'active', 'starter', $4, $5)
         ON CONFLICT (org_id, module)
         DO UPDATE SET
           status = 'active',
           user_id = EXCLUDED.user_id,
           plan = EXCLUDED.plan,
           activated_at = EXCLUDED.activated_at,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
         RETURNING *`,
        [userId, orgId, canonical, now, expiresAt]
      );
      results.push(rows[0]);

      // Allocate base credits for marketing on activation
      if (modId === 'marketing' && orgId) {
        const limits = MODULES.marketing.limits;
        const baseCredits = (limits.images || 20) + (limits.videos || 4);

        const { rows: creditRows } = await client.query(
          `INSERT INTO marketing_credits (org_id, user_id, balance)
           VALUES ($1, $2, $3)
           ON CONFLICT (org_id) DO UPDATE
             SET balance = marketing_credits.balance + $3, updated_at = NOW()
           RETURNING balance`,
          [orgId, userId, baseCredits]
        );

        await client.query(
          `INSERT INTO credit_transactions
             (org_id, user_id, amount, type, balance_after, reference_type, description)
           VALUES ($1, $2, $3, 'credit', $4, 'subscription', 'Base credits from subscription activation')`,
          [orgId, userId, baseCredits, creditRows[0]?.balance || baseCredits]
        );
      }
    }

    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deactivate (cancel) a subscription.
 */
async function deactivateSubscription(userId, moduleId) {
  const moduleKey = normalizeModuleKey(moduleId);
  const { rows } = await db.query(
    `UPDATE subscriptions
     SET status = 'inactive', cancelled_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND module = $2
     RETURNING *`,
    [userId, moduleKey]
  );
  return rows[0] || null;
}

/**
 * Pause a subscription.
 */
async function pauseSubscription(userId, moduleId) {
  const moduleKey = normalizeModuleKey(moduleId);
  const { rows } = await db.query(
    `UPDATE subscriptions
     SET status = 'paused', paused_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND module = $2
     RETURNING *`,
    [userId, moduleKey]
  );
  return rows[0] || null;
}

/**
 * Resume a paused subscription.
 */
async function resumeSubscription(userId, moduleId) {
  const moduleKey = normalizeModuleKey(moduleId);
  const { rows } = await db.query(
    `UPDATE subscriptions
     SET status = 'active', paused_at = NULL, updated_at = NOW()
     WHERE user_id = $1 AND module = $2
     RETURNING *`,
    [userId, moduleKey]
  );
  return rows[0] || null;
}

/**
 * Get credit balance for an org.
 */
async function getCreditBalance(orgId) {
  const { rows } = await db.query(
    `SELECT balance FROM marketing_credits WHERE org_id = $1`,
    [orgId]
  );
  return rows[0]?.balance ?? 0;
}

/**
 * Consume credits (decrement balance).
 * Returns true if successful, false if insufficient balance.
 */
async function consumeCredit(orgId, type, amount = 1, userId = null) {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT balance FROM marketing_credits WHERE org_id = $1 FOR UPDATE`,
      [orgId]
    );

    if (!rows[0] || rows[0].balance < amount) {
      await client.query('ROLLBACK');
      return false;
    }

    const newBalance = rows[0].balance - amount;

    await client.query(
      `UPDATE marketing_credits SET balance = $1, updated_at = NOW() WHERE org_id = $2`,
      [newBalance, orgId]
    );

    await client.query(
      `INSERT INTO credit_transactions
         (org_id, user_id, amount, type, balance_after, reference_type, description)
       VALUES ($1, $2, $3, 'debit', $4, $5, $6)`,
      [orgId, userId, amount, newBalance, type, `Consumed ${amount} ${type} credit(s)`]
    );

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Add credits to an org's balance.
 */
async function addCredits(orgId, amount, source = 'topup', userId = null) {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO marketing_credits (org_id, user_id, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET balance = marketing_credits.balance + $3, updated_at = NOW()
       RETURNING balance`,
      [orgId, userId, amount]
    );

    await client.query(
      `INSERT INTO credit_transactions
         (org_id, user_id, amount, type, balance_after, reference_type, description)
       VALUES ($1, $2, $3, 'credit', $4, $5, $6)`,
      [orgId, userId, amount, rows[0].balance, source, `Added ${amount} credits via ${source}`]
    );

    await client.query('COMMIT');
    return rows[0].balance;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get credit transaction history for an org.
 */
async function getCreditTransactions(orgId, limit = 50) {
  const { rows } = await db.query(
    `SELECT * FROM credit_transactions WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [orgId, limit]
  );
  return rows;
}

/**
 * Check if a module is active for a user.
 */
async function isModuleActive(userId, moduleId) {
  const sub = await getSubscription(userId, normalizeModuleKey(moduleId));
  return sub && (sub.status === 'active' || sub.status === 'trial');
}

module.exports = {
  MODULES,
  getUserSubscriptions,
  getSubscription,
  activateSubscription,
  deactivateSubscription,
  pauseSubscription,
  resumeSubscription,
  getCreditBalance,
  consumeCredit,
  addCredits,
  getCreditTransactions,
  isModuleActive,
};
