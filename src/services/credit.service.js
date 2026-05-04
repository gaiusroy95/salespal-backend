const db = require('../config/db');
const logger = require('../config/logger');

/**
 * Get credit balance for an org.
 */
async function getBalance(orgId) {
  const { rows } = await db.query(
    `SELECT balance FROM marketing_credits WHERE org_id = $1`,
    [orgId]
  );
  return rows[0]?.balance ?? 0;
}

/**
 * Ensure a marketing_credits row exists for the org (idempotent).
 */
async function ensureCreditsRow(orgId, userId = null) {
  await db.query(
    `INSERT INTO marketing_credits (org_id, user_id, balance)
     VALUES ($1, $2, 0)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId, userId]
  );
}

/**
 * Add credits to an org's balance.
 * @param {string} orgId
 * @param {number} amount
 * @param {string} source  - reference_type label (e.g. 'subscription', 'topup', 'admin')
 * @param {string} [description]
 * @param {string} [userId]
 * @returns {number} new balance
 */
async function addCredits(orgId, amount, source = 'topup', description = null, userId = null) {
  return db.transaction(async (client) => {
    // Upsert credits row
    const { rows } = await client.query(
      `INSERT INTO marketing_credits (org_id, user_id, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET balance = marketing_credits.balance + $3, updated_at = NOW()
       RETURNING balance`,
      [orgId, userId, amount]
    );

    const newBalance = rows[0].balance;

    await client.query(
      `INSERT INTO credit_transactions
         (org_id, user_id, amount, type, balance_after, reference_type, description)
       VALUES ($1, $2, $3, 'credit', $4, $5, $6)`,
      [orgId, userId, amount, newBalance, source, description || `Added ${amount} credits via ${source}`]
    );

    logger.info(`Credits added: org=${orgId} amount=${amount} source=${source} balance=${newBalance}`);
    return newBalance;
  });
}

/**
 * Consume credits from an org's balance.
 * Returns true if successful, false if insufficient balance.
 * @param {string} orgId
 * @param {number} amount
 * @param {string} type  - reference_type label (e.g. 'image', 'video', 'post')
 * @param {string} [description]
 * @param {string} [userId]
 */
async function consumeCredits(orgId, amount, type = 'consume', description = null, userId = null) {
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
      [orgId, userId, amount, newBalance, type, description || `Consumed ${amount} ${type} credit(s)`]
    );

    await client.query('COMMIT');
    logger.info(`Credits consumed: org=${orgId} amount=${amount} type=${type} balance=${newBalance}`);
    return true;
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
async function getTransactions(orgId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM credit_transactions
     WHERE org_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [orgId, limit, offset]
  );
  return rows;
}

/**
 * Refund credits (reverse a debit).
 */
async function refundCredits(orgId, amount, referenceId = null, userId = null) {
  return db.transaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO marketing_credits (org_id, user_id, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id) DO UPDATE
         SET balance = marketing_credits.balance + $3, updated_at = NOW()
       RETURNING balance`,
      [orgId, userId, amount]
    );

    const newBalance = rows[0].balance;

    await client.query(
      `INSERT INTO credit_transactions
         (org_id, user_id, amount, type, balance_after, reference_type, reference_id, description)
       VALUES ($1, $2, $3, 'refund', $4, 'refund', $5, $6)`,
      [orgId, userId, amount, newBalance, referenceId, `Refunded ${amount} credits`]
    );

    return newBalance;
  });
}

module.exports = {
  getBalance,
  ensureCreditsRow,
  addCredits,
  consumeCredits,
  getTransactions,
  refundCredits,
};
