const pool = require('../config/db.js');

// ─── Helper: log admin action ─────────────────────────────────────────────────
async function logAudit(req, actionType, entityType, entityId, metadata = {}) {
  const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
  await pool.query(
    `INSERT INTO admin_audit_log (user_id, action_type, entity_type, entity_id, metadata, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [req.user.id, actionType, entityType, entityId || null, JSON.stringify(metadata), ip]
  );
}

// ─── Existing: List Users ─────────────────────────────────────────────────────
exports.listUsers = async (req, res, next) => {
  try {
    const { search, status, role, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    let where = [];
    let params = [];
    let idx = 1;

    if (search) {
      where.push(`(u.email ILIKE $${idx} OR u.full_name ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    if (status && status !== 'all') {
      where.push(`COALESCE(u.status, 'active') = $${idx}`);
      params.push(status);
      idx++;
    }
    if (role && role !== 'all') {
      where.push(`u.role = $${idx}`);
      params.push(role);
      idx++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM users u ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const result = await pool.query(`
      SELECT u.id, u.email, u.full_name, u.role, COALESCE(u.status, 'active') as status, u.created_at,
             o.name as organization_name, o.id as org_id
      FROM users u
      LEFT JOIN org_members om ON u.id = om.user_id
      LEFT JOIN organizations o ON om.org_id = o.id
      ${whereClause}
      ORDER BY u.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, params);

    res.json({ users: result.rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    next(error);
  }
};

// ─── Existing: List Subscriptions ─────────────────────────────────────────────
exports.listSubscriptions = async (req, res, next) => {
  try {
    // When an org has a salespal360 subscription, hide the individual module rows
    // (marketing, sales, postSale, support) that were auto-created alongside it.
    // Only display the salespal360 row for that org.
    const result = await pool.query(`
      SELECT s.*, o.name as organization_name, u.email as user_email, u.full_name as user_name
      FROM subscriptions s
      JOIN organizations o ON s.org_id = o.id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE NOT (
        s.module IN ('marketing', 'sales', 'postSale', 'support')
        AND EXISTS (
          SELECT 1 FROM subscriptions s2
          WHERE s2.org_id = s.org_id
            AND s2.module = 'salespal360'
            AND s2.status = 'active'
        )
      )
      ORDER BY s.created_at DESC LIMIT 100
    `);
    res.json({ subscriptions: result.rows });
  } catch (error) {
    next(error);
  }
};

// ─── Existing: List Projects ──────────────────────────────────────────────────
exports.listProjects = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT p.*, o.name as organization_name
      FROM projects p
      JOIN organizations o ON p.org_id = o.id
      ORDER BY p.created_at DESC LIMIT 100
    `);
    res.json({ projects: result.rows });
  } catch (error) {
    next(error);
  }
};

// ─── Existing: List Campaigns ─────────────────────────────────────────────────
exports.listCampaigns = async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT c.id, c.name, c.status, c.platform, c.launched_at, o.name as organization_name
      FROM campaigns c
      JOIN organizations o ON c.org_id = o.id
      ORDER BY c.created_at DESC LIMIT 100
    `);
    res.json({ campaigns: result.rows });
  } catch (error) {
    next(error);
  }
};

// ─── Existing: Analytics (enriched for dashboard + analytics pages) ───────────
exports.getAnalytics = async (req, res, next) => {
  try {
    const usersCount = await pool.query('SELECT COUNT(*) FROM users');
    const revenueSum = await pool.query("SELECT COALESCE(SUM(amount), 0) FROM credit_transactions WHERE type = 'consume'");
    const activeSubs = await pool.query("SELECT module, COUNT(*) FROM subscriptions WHERE status = 'active' GROUP BY module");
    const totalSubsRes = await pool.query("SELECT COUNT(*) FROM subscriptions WHERE status = 'active'");
    const newUsers = await pool.query("SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days'");
    const projectsCount = await pool.query('SELECT COUNT(*) FROM projects');
    const campaignsTotal = await pool.query('SELECT COUNT(*) FROM campaigns');
    const campaignsActive = await pool.query("SELECT COUNT(*) FROM campaigns WHERE status = 'active'");

    // Recent activity — last 10 audit log entries
    const recentActivity = await pool.query(`
      SELECT a.action_type, a.entity_type, a.metadata, a.created_at, u.email as user_email, u.full_name as user_name
      FROM admin_audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.created_at DESC LIMIT 10
    `);

    // Recent user registrations for activity feed
    const recentUsers = await pool.query(`
      SELECT full_name, email, created_at FROM users ORDER BY created_at DESC LIMIT 5
    `);

    res.json({
      analytics: {
        totalUsers: parseInt(usersCount.rows[0].count),
        totalRevenue: Math.abs(parseFloat(revenueSum.rows[0].coalesce)),
        activeSubscriptions: activeSubs.rows,
        totalActiveSubscriptions: parseInt(totalSubsRes.rows[0].count),
        newUsers30Days: parseInt(newUsers.rows[0].count),
        totalProjects: parseInt(projectsCount.rows[0].count),
        totalCampaigns: parseInt(campaignsTotal.rows[0].count),
        activeCampaigns: parseInt(campaignsActive.rows[0].count),
        recentActivity: recentActivity.rows,
        recentUsers: recentUsers.rows
      }
    });
  } catch (error) {
    next(error);
  }
};

// ─── Legacy: Get/Update Settings (kept for backward compat) ───────────────────
exports.getSettings = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT key, value FROM platform_settings");
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (error) {
    next(error);
  }
};

exports.updateSettings = async (req, res, next) => {
  try {
    await logAudit(req, 'UPDATE_SETTINGS', 'SYSTEM', null, req.body);
    res.json({ message: 'Settings updated successfully' });
  } catch (error) {
    next(error);
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// NEW ADMIN SETTINGS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── 1. Platform Config ───────────────────────────────────────────────────────

exports.getPlatformConfig = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM platform_settings WHERE key = 'platform_config'");
    const config = result.rows[0]?.value || {
      modules: { marketing: true, sales: true, 'post-sales': true, support: true },
      features: { ai_calling: true, whatsapp_automation: true },
      maintenance_mode: false
    };
    res.json({ config });
  } catch (error) {
    next(error);
  }
};

exports.updatePlatformConfig = async (req, res, next) => {
  try {
    const { config } = req.body;
    if (!config) return res.status(400).json({ message: 'Config object is required' });

    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('platform_config', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
      [JSON.stringify(config), req.user.id]
    );

    await logAudit(req, 'UPDATE_PLATFORM_CONFIG', 'SYSTEM', null, config);
    res.json({ message: 'Platform config updated', config });
  } catch (error) {
    next(error);
  }
};

// ─── 2. Module Pricing ────────────────────────────────────────────────────────

exports.getModulePricing = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM platform_settings WHERE key = 'module_pricing'");
    const pricing = result.rows[0]?.value || {};
    res.json({ pricing });
  } catch (error) {
    next(error);
  }
};

exports.updateModulePricing = async (req, res, next) => {
  try {
    const { module } = req.params;
    const { monthly, yearly, enabled } = req.body;

    const validModules = ['marketing', 'sales', 'post-sales', 'support', 'salespal-360'];
    if (!validModules.includes(module)) {
      return res.status(400).json({ message: `Invalid module: ${module}` });
    }

    // Get current pricing
    const result = await pool.query("SELECT value FROM platform_settings WHERE key = 'module_pricing'");
    const pricing = result.rows[0]?.value || {};

    // Update the specific module
    pricing[module] = {
      monthly: monthly !== undefined ? monthly : (pricing[module]?.monthly || 0),
      yearly: yearly !== undefined ? yearly : (pricing[module]?.yearly || 0),
      enabled: enabled !== undefined ? enabled : (pricing[module]?.enabled ?? true)
    };

    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('module_pricing', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
      [JSON.stringify(pricing), req.user.id]
    );

    await logAudit(req, 'UPDATE_MODULE_PRICING', 'MODULE', null, { module, monthly, yearly, enabled });
    res.json({ message: `Pricing updated for ${module}`, pricing });
  } catch (error) {
    next(error);
  }
};

// ─── 3. User Roles ────────────────────────────────────────────────────────────

exports.updateUserRole = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['user', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Role must be "user" or "admin"' });
    }

    // Prevent self-demotion
    if (id === req.user.id && role !== 'admin') {
      return res.status(400).json({ message: 'You cannot demote yourself' });
    }

    const result = await pool.query(
      'UPDATE users SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, full_name, role',
      [role, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    await logAudit(req, 'UPDATE_USER_ROLE', 'USER', id, { newRole: role });
    res.json({ message: `User role updated to ${role}`, user: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

exports.updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'suspended', 'banned'].includes(status)) {
      return res.status(400).json({ message: 'Status must be "active", "suspended", or "banned"' });
    }

    // Prevent self-suspension
    if (id === req.user.id) {
      return res.status(400).json({ message: 'You cannot change your own status' });
    }

    const result = await pool.query(
      'UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, full_name, role, status',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    // If suspended or banned, invalidate their refresh tokens
    if (status !== 'active') {
      await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [id]);
    }

    await logAudit(req, 'UPDATE_USER_STATUS', 'USER', id, { newStatus: status });
    res.json({ message: `User status updated to ${status}`, user: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

// ─── 4. Billing Control ──────────────────────────────────────────────────────

exports.updateSubscription = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, module } = req.body;

    const updates = [];
    const params = [];
    let idx = 1;

    if (status) {
      if (!['active', 'inactive', 'paused'].includes(status)) {
        return res.status(400).json({ message: 'Invalid subscription status' });
      }
      updates.push(`status = $${idx}`);
      params.push(status);
      idx++;

      if (status === 'active') {
        updates.push(`activated_at = NOW()`);
      } else if (status === 'inactive') {
        updates.push(`deactivated_at = NOW()`);
      } else if (status === 'paused') {
        updates.push(`paused_at = NOW()`);
      }
    }

    if (module) {
      updates.push(`module = $${idx}`);
      params.push(module);
      idx++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: 'No updates provided' });
    }

    updates.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    await logAudit(req, 'UPDATE_SUBSCRIPTION', 'SUBSCRIPTION', id, { status, module });
    res.json({ message: 'Subscription updated', subscription: result.rows[0] });
  } catch (error) {
    next(error);
  }
};

exports.issueRefund = async (req, res, next) => {
  try {
    const { subscription_id, amount, reason } = req.body;

    if (!subscription_id || !amount) {
      return res.status(400).json({ message: 'subscription_id and amount are required' });
    }

    // Verify subscription exists
    const subRes = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [subscription_id]);
    if (subRes.rows.length === 0) {
      return res.status(404).json({ message: 'Subscription not found' });
    }

    // Record refund as a credit transaction
    await pool.query(
      `INSERT INTO credit_transactions (org_id, type, amount, description, created_at)
       VALUES ($1, 'refund', $2, $3, NOW())`,
      [subRes.rows[0].org_id, amount, reason || 'Admin-issued refund']
    );

    await logAudit(req, 'ISSUE_REFUND', 'SUBSCRIPTION', subscription_id, { amount, reason });
    res.json({ message: `Refund of ₹${amount} issued successfully` });
  } catch (error) {
    next(error);
  }
};

// ─── 5. Notifications ─────────────────────────────────────────────────────────

exports.getNotificationSettings = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM platform_settings WHERE key = 'notification_settings'");
    const settings = result.rows[0]?.value || { email_enabled: true, whatsapp_enabled: true };
    res.json({ settings });
  } catch (error) {
    next(error);
  }
};

exports.updateNotificationSettings = async (req, res, next) => {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ message: 'Settings object is required' });

    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('notification_settings', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
      [JSON.stringify(settings), req.user.id]
    );

    await logAudit(req, 'UPDATE_NOTIFICATION_SETTINGS', 'SYSTEM', null, settings);
    res.json({ message: 'Notification settings updated', settings });
  } catch (error) {
    next(error);
  }
};

exports.getComplianceSettings = async (req, res, next) => {
  try {
    const result = await pool.query("SELECT value FROM platform_settings WHERE key = 'compliance_settings'");
    const settings = result.rows[0]?.value || {
      retention_days: 365,
      call_recording_encrypted: true,
      pii_access_audit: true,
      incident_response_runbook: true,
    };
    res.json({ settings });
  } catch (error) {
    next(error);
  }
};

exports.updateComplianceSettings = async (req, res, next) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return res.status(400).json({ message: 'settings object is required' });
    }
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('compliance_settings', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
      [JSON.stringify(settings), req.user.id]
    );
    await logAudit(req, 'UPDATE_COMPLIANCE_SETTINGS', 'SYSTEM', null, settings);
    res.json({ message: 'Compliance settings updated', settings });
  } catch (error) {
    next(error);
  }
};

exports.broadcastNotification = async (req, res, next) => {
  try {
    const { title, message, type = 'broadcast' } = req.body;

    if (!title || !message) {
      return res.status(400).json({ message: 'Title and message are required' });
    }

    // Get all active user IDs
    const usersRes = await pool.query("SELECT id FROM users WHERE COALESCE(status, 'active') = 'active'");

    // Bulk insert notifications for all users (write to both body & message columns for compat)
    if (usersRes.rows.length > 0) {
      const values = usersRes.rows.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
      const params = usersRes.rows.flatMap(u => [u.id, type, title, message, message]);

      await pool.query(
        `INSERT INTO notifications (user_id, type, title, message, body) VALUES ${values}`,
        params
      );
    }

    await logAudit(req, 'BROADCAST_NOTIFICATION', 'SYSTEM', null, { title, recipientCount: usersRes.rows.length });
    res.json({ message: `Broadcast sent to ${usersRes.rows.length} users` });
  } catch (error) {
    next(error);
  }
};

// ─── 5b. Admin Notification Feed ──────────────────────────────────────────────

exports.listAdminNotifications = async (req, res, next) => {
  try {
    // Fetch notifications targeted at the admin user + broadcast notifications
    const result = await pool.query(`
      SELECT id, type, title, COALESCE(body, message, title) as message, read, metadata, created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 30
    `, [req.user.id]);

    // Also fetch recent platform events from audit log for admin awareness
    const eventsResult = await pool.query(`
      SELECT
        a.id, a.action_type, a.entity_type, a.metadata, a.created_at,
        u.email as actor_email, u.full_name as actor_name
      FROM admin_audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.created_at > NOW() - INTERVAL '7 days'
      ORDER BY a.created_at DESC
      LIMIT 20
    `);

    // Fetch recent user registrations as events
    const recentUsersResult = await pool.query(`
      SELECT id, email, full_name, created_at
      FROM users
      WHERE created_at > NOW() - INTERVAL '7 days'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // Build a unified feed: DB notifications + synthesized events
    const dbNotifications = result.rows.map(n => ({
      id: n.id,
      type: n.type || 'system',
      title: n.title,
      message: n.message,
      read: n.read,
      source: 'notification',
      created_at: n.created_at,
    }));

    // Build synthesized events from audit logs (these aren't "read"-able)
    const auditEvents = eventsResult.rows.map(e => {
      const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : (e.metadata || {});
      const actionLabel = (e.action_type || '').replace(/_/g, ' ').toLowerCase();
      const actor = e.actor_name || e.actor_email || 'System';
      return {
        id: `audit-${e.id}`,
        type: 'audit',
        title: `Admin Action`,
        message: `${actor} – ${actionLabel}`,
        read: true, // audit events are informational
        source: 'audit',
        created_at: e.created_at,
      };
    });

    const registrationEvents = recentUsersResult.rows.map(u => ({
      id: `reg-${u.id}`,
      type: 'registration',
      title: 'New User Registration',
      message: `${u.full_name || u.email} registered`,
      read: true, // informational
      source: 'registration',
      created_at: u.created_at,
    }));

    // Merge & sort by date, prioritize unread DB notifications
    const allItems = [...dbNotifications, ...registrationEvents, ...auditEvents]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 30);

    const unreadCount = dbNotifications.filter(n => !n.read).length;

    res.json({ notifications: allItems, unreadCount });
  } catch (error) {
    next(error);
  }
};

exports.markAdminNotificationRead = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Notification not found' });
    }
    res.json({ message: 'Marked as read' });
  } catch (error) {
    next(error);
  }
};

exports.markAllAdminNotificationsRead = async (req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE notifications SET read = true WHERE user_id = $1 AND read = false RETURNING id',
      [req.user.id]
    );
    res.json({ message: 'All marked as read', count: result.rowCount });
  } catch (error) {
    next(error);
  }
};

// ─── 6. Security & Logs ──────────────────────────────────────────────────────

exports.getAuditLogs = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, action_type, user_id } = req.query;
    const offset = (page - 1) * limit;

    let where = [];
    let params = [];
    let idx = 1;

    if (action_type) {
      where.push(`a.action_type = $${idx}`);
      params.push(action_type);
      idx++;
    }
    if (user_id) {
      where.push(`a.user_id = $${idx}`);
      params.push(user_id);
      idx++;
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*) FROM admin_audit_log a ${whereClause}`, params);
    const total = parseInt(countRes.rows[0].count);

    params.push(limit, offset);
    const result = await pool.query(`
      SELECT a.*, u.email as user_email, u.full_name as user_name
      FROM admin_audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, params);

    res.json({ logs: result.rows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    next(error);
  }
};

exports.forceLogout = async (req, res, next) => {
  try {
    const { userId } = req.params;

    // Prevent self-logout
    if (userId === req.user.id) {
      return res.status(400).json({ message: 'You cannot force-logout yourself' });
    }

    // Delete all refresh tokens for the user
    const result = await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);

    await logAudit(req, 'FORCE_LOGOUT', 'USER', userId, { tokensRevoked: result.rowCount });
    res.json({ message: 'User sessions terminated', tokensRevoked: result.rowCount });
  } catch (error) {
    next(error);
  }
};
