const db = require('../config/db');
const orgService = require('../services/org.service');

async function getMe(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.full_name, u.avatar_url, u.role, u.metadata, u.created_at,
              om.org_id, om.role AS org_role, o.name AS org_name
       FROM users u
       LEFT JOIN org_members om ON u.id = om.user_id
       LEFT JOIN organizations o ON om.org_id = o.id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    const { password_hash, ...user } = rows[0];
    res.json(user);
  } catch (err) {
    next(err);
  }
}

async function updateMe(req, res, next) {
  try {
    const { fullName, avatarUrl, metadata } = req.body;
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (fullName !== undefined) {
      updates.push(`full_name = $${paramIndex++}`);
      values.push(fullName);
    }
    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${paramIndex++}`);
      values.push(avatarUrl);
    }
    if (metadata !== undefined) {
      updates.push(`metadata = $${paramIndex++}`);
      values.push(JSON.stringify(metadata));
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No fields to update' },
      });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.user.id);

    const { rows } = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING id, email, full_name, avatar_url, role, metadata, updated_at`,
      values
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function getUserById(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, email, full_name, avatar_url, role, created_at FROM users WHERE id = $1`,
      [req.params.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function getSettings(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT metadata->'settings' AS settings FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    res.json(rows[0].settings || {});
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const settings = req.body;
    
    // Merge new settings with existing metadata
    const { rows } = await db.query(
      `UPDATE users 
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('settings', COALESCE(metadata->'settings', '{}'::jsonb) || $1::jsonb),
           updated_at = NOW()
       WHERE id = $2 
       RETURNING metadata->'settings' AS settings`,
      [JSON.stringify(settings), req.user.id]
    );

    res.json(rows[0].settings || {});
  } catch (err) {
    next(err);
  }
}

async function getMyOrg(req, res, next) {
  try {
    const org = await orgService.getOrgByUserId(req.user.id);
    if (!org) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Organization not found' } });
    }
    res.json(org);
  } catch (err) {
    next(err);
  }
}

async function bootstrapOrg(req, res, next) {
  try {
    // Optionally pass req.body.name if bootstrapUserOrg accepts it, but currently it hardcodes 'My Workspace'
    const result = await orgService.bootstrapUserOrg(req.user.id);
    res.status(201).json(result.org);
  } catch (err) {
    next(err);
  }
}

module.exports = { getMe, updateMe, getUserById, getMyOrg, bootstrapOrg, getSettings, updateSettings };
