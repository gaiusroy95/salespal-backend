const db = require('../config/db');
const logger = require('../config/logger');

/**
 * Get the primary org for a user (first org they belong to).
 */
async function getUserOrg(userId) {
  const { rows } = await db.query(
    `SELECT o.*, om.role AS member_role
     FROM organizations o
     JOIN org_members om ON om.org_id = o.id
     WHERE om.user_id = $1
     ORDER BY om.joined_at ASC
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

/**
 * Get all orgs a user belongs to.
 */
async function getUserOrgs(userId) {
  const { rows } = await db.query(
    `SELECT o.*, om.role AS member_role, om.joined_at
     FROM organizations o
     JOIN org_members om ON om.org_id = o.id
     WHERE om.user_id = $1
     ORDER BY om.joined_at ASC`,
    [userId]
  );
  return rows;
}

/**
 * Get org by ID (with member count).
 */
async function getOrgById(orgId) {
  const { rows } = await db.query(
    `SELECT o.*,
       (SELECT COUNT(*) FROM org_members WHERE org_id = o.id) AS member_count
     FROM organizations o
     WHERE o.id = $1`,
    [orgId]
  );
  return rows[0] || null;
}

/**
 * Create a new organization and add the creator as owner.
 */
async function createOrg(userId, { name, slug }) {
  return db.transaction(async (client) => {
    // Ensure slug is unique
    const safeSlug = (slug || name)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (name, slug, owner_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name, safeSlug + '-' + Date.now(), userId]
    );
    const org = orgRows[0];

    await client.query(
      `INSERT INTO org_members (user_id, org_id, role)
       VALUES ($1, $2, 'owner')`,
      [userId, org.id]
    );

    logger.info(`Org created: ${org.id} by user ${userId}`);
    return org;
  });
}

/**
 * Update org details (owner only).
 */
async function updateOrg(orgId, userId, updates) {
  const allowed = ['name', 'slug', 'plan'];
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key) && val !== undefined) {
      sets.push(`${key} = $${idx++}`);
      vals.push(val);
    }
  }

  if (sets.length === 0) return null;

  sets.push(`updated_at = NOW()`);
  vals.push(orgId);

  const { rows } = await db.query(
    `UPDATE organizations SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return rows[0] || null;
}

/**
 * Get all members of an org.
 */
async function getOrgMembers(orgId) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.full_name, u.avatar_url, u.role AS system_role,
            om.role AS org_role, om.joined_at
     FROM org_members om
     JOIN users u ON u.id = om.user_id
     WHERE om.org_id = $1
     ORDER BY om.joined_at ASC`,
    [orgId]
  );
  return rows;
}

/**
 * Invite (add) a user to an org by email.
 */
async function inviteMember(orgId, email, role = 'member') {
  const { rows: userRows } = await db.query(
    `SELECT id FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  if (!userRows[0]) {
    const err = new Error('User not found with that email');
    err.statusCode = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const userId = userRows[0].id;

  const { rows } = await db.query(
    `INSERT INTO org_members (user_id, org_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [userId, orgId, role]
  );
  return rows[0];
}

/**
 * Remove a member from an org.
 */
async function removeMember(orgId, targetUserId) {
  const { rowCount } = await db.query(
    `DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, targetUserId]
  );
  return rowCount > 0;
}

/**
 * Check if a user is a member of an org.
 */
async function isMember(orgId, userId) {
  const { rows } = await db.query(
    `SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId]
  );
  return rows[0] || null;
}

/**
 * Get the org_id for a user (convenience helper used across controllers).
 */
async function getOrgIdForUser(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

/**
 * Alias for getUserOrg — used by users.controller.
 */
async function getOrgByUserId(userId) {
  return getUserOrg(userId);
}

/**
 * Bootstrap: ensure a user has at least one org. Creates one if missing.
 */
async function bootstrapUserOrg(userId) {
  const existing = await getUserOrg(userId);
  if (existing) return { org: existing, created: false };

  // Get user info for org name
  const db = require('../config/db');
  const { rows } = await db.query(`SELECT email, full_name FROM users WHERE id = $1`, [userId]);
  const user = rows[0];
  const name = user?.full_name ? `${user.full_name}'s Workspace` : (user?.email?.split('@')[0] + "'s Workspace") || 'My Workspace';

  const org = await createOrg(userId, { name, slug: name });
  return { org, created: true };
}

module.exports = {
  getUserOrg,
  getUserOrgs,
  getOrgById,
  createOrg,
  updateOrg,
  getOrgMembers,
  inviteMember,
  removeMember,
  isMember,
  getOrgIdForUser,
  getOrgByUserId,
  bootstrapUserOrg,
};
