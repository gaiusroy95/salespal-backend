const pool = require('../config/db.js');

exports.listNotifications = async (req, res, next) => {
  try {
    let query = `SELECT id, user_id, org_id, type, title,
                        COALESCE(message, body, '') as message,
                        read, metadata, created_at
                 FROM notifications WHERE user_id = $1`;
    const params = [req.user.id];

    if (req.query.read !== undefined) {
      query += ' AND read = $2';
      params.push(req.query.read === 'true');
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json({ notifications: result.rows });
  } catch (error) {
    next(error);
  }
};

exports.markRead = async (req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING *',
      [req.params.id, req.user.id]
    );
    res.json({ notification: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

exports.markAllRead = async (req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false RETURNING id',
      [req.user.id]
    );
    res.json({ count: result.rowCount });
  } catch (error) {
    next(error);
  }
};

exports.getPreferences = async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM notification_preferences WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ preferences: result.rows });
  } catch (error) {
    next(error);
  }
};

exports.updatePreferences = async (req, res, next) => {
  try {
    const { preferences } = req.body;
    if (!Array.isArray(preferences)) {
      return res.status(400).json({ error: 'Preferences must be an array' });
    }

    const checkOrg = await pool.query('SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1', [req.user.id]);
    const orgId = checkOrg.rows[0]?.org_id;

    for (const pref of preferences) {
      await pool.query(
        `INSERT INTO notification_preferences (user_id, org_id, channel, type, enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (user_id, channel, type) DO UPDATE 
         SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
        [req.user.id, orgId, pref.channel, pref.type, pref.enabled]
      );
    }

    const result = await pool.query('SELECT * FROM notification_preferences WHERE user_id = $1', [req.user.id]);
    res.json({ preferences: result.rows });
  } catch (error) {
    next(error);
  }
};
