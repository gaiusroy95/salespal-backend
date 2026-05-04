const db = require('../config/db');

async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

function hasLegalRisk(content) {
  const text = String(content || '').toLowerCase();
  return /(police|complaint|sue|legal notice|court case|consumer court|lawsuit|lawyer)/i.test(text);
}

async function listTickets(req, res, next) {
  try {
    const { status, priority, assignedTo, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT t.*, u.full_name AS assigned_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id WHERE t.user_id = $1`;
    const params = [req.user.id];
    let idx = 2;

    if (status) { sql += ` AND t.status = $${idx++}`; params.push(status); }
    if (priority) { sql += ` AND t.priority = $${idx++}`; params.push(priority); }
    if (assignedTo) { sql += ` AND t.assigned_to = $${idx++}`; params.push(assignedTo); }

    sql += ` ORDER BY t.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getTicket(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT t.*, u.full_name AS assigned_name FROM tickets t LEFT JOIN users u ON t.assigned_to = u.id
       WHERE t.id = $1 AND t.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });

    // Fetch comments
    const comments = await db.query(
      `SELECT tc.*, u.full_name AS author_name FROM ticket_comments tc LEFT JOIN users u ON tc.user_id = u.id
       WHERE tc.ticket_id = $1 ORDER BY tc.created_at ASC`,
      [req.params.id]
    );

    res.json({ ...rows[0], comments: comments.rows });
  } catch (err) {
    next(err);
  }
}

async function createTicket(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { subject, description, priority, category, metadata } = req.body;
    const legalRisk = hasLegalRisk(`${subject || ''} ${description || ''}`);
    const mergedMetadata = {
      ...(metadata || {}),
      escalation: legalRisk ? 'human_immediate' : (metadata?.escalation || null),
      riskFlags: legalRisk ? ['legal_threat'] : (metadata?.riskFlags || []),
    };

    const { rows } = await db.query(
      `INSERT INTO tickets (user_id, org_id, subject, description, priority, category, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, orgId, subject, description, legalRisk ? 'high' : (priority || 'medium'), category || null, JSON.stringify(mergedMetadata)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateTicket(req, res, next) {
  try {
    const { subject, description, status, priority, category, assignedTo, metadata } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (subject !== undefined) { updates.push(`subject = $${idx++}`); values.push(subject); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (status !== undefined) {
      updates.push(`status = $${idx++}`); values.push(status);
      if (status === 'resolved') { updates.push(`resolved_at = NOW()`); }
    }
    if (priority !== undefined) { updates.push(`priority = $${idx++}`); values.push(priority); }
    if (category !== undefined) { updates.push(`category = $${idx++}`); values.push(category); }
    if (assignedTo !== undefined) { updates.push(`assigned_to = $${idx++}`); values.push(assignedTo); }
    if (metadata !== undefined) { updates.push(`metadata = $${idx++}`); values.push(JSON.stringify(metadata)); }

    if (updates.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
    }

    const legalRisk = hasLegalRisk(`${subject || ''} ${description || ''}`);
    if (legalRisk) {
      updates.push(`priority = $${idx++}`);
      values.push('high');
      updates.push(`assigned_to = NULL`);
      if (metadata === undefined) {
        updates.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${idx++}::jsonb`);
        values.push(JSON.stringify({ escalation: 'human_immediate', riskFlags: ['legal_threat'] }));
      }
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id, req.user.id);

    const { rows } = await db.query(
      `UPDATE tickets SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function addComment(req, res, next) {
  try {
    // Verify ticket ownership
    const ticket = await db.query(
      `SELECT id FROM tickets WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!ticket.rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });

    const { content, isInternal } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ticket_comments (ticket_id, user_id, content, is_internal)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, req.user.id, content, isInternal || false]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function deleteTicket(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM tickets WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });
    res.json({ message: 'Ticket deleted' });
  } catch (err) {
    next(err);
  }
}

module.exports = { listTickets, getTicket, createTicket, updateTicket, addComment, deleteTicket };
