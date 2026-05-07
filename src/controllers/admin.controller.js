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

async function getSettingJson(key, fallback = {}) {
  const result = await pool.query('SELECT value FROM platform_settings WHERE key = $1 LIMIT 1', [key]);
  const raw = result.rows[0]?.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
  return raw;
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

// ─── Command Center ───────────────────────────────────────────────────────────
exports.getCommandCenter = async (req, res, next) => {
  try {
    const [
      usersCount,
      activeSubsRes,
      revenueRes,
      waHealthRes,
      callHealthRes,
      criticalAlertsRes,
      enterpriseAlertsRes,
      recentActivity,
      aiActionsRes,
      humanEscalationsRes,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS c FROM users'),
      pool.query("SELECT COUNT(*)::int AS c FROM subscriptions WHERE status = 'active'"),
      pool.query("SELECT COALESCE(SUM(amount), 0)::numeric AS v FROM credit_transactions WHERE type = 'consume'"),
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome IN ('whatsapp_send_failed','automation_whatsapp_failed') THEN 1 ELSE 0 END)::int AS failed
         FROM lead_actions
         WHERE type = 'whatsapp'
           AND created_at > NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome IN ('automation_call_failed') THEN 1 ELSE 0 END)::int AS failed
         FROM lead_actions
         WHERE type = 'call'
           AND created_at > NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
         FROM notifications
         WHERE type IN ('sales_automation', 'security')
           AND read = false
           AND created_at > NOW() - INTERVAL '48 hours'`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
         FROM notifications
         WHERE type = 'enterprise'
           AND read = false
           AND created_at > NOW() - INTERVAL '7 days'`
      ),
      pool.query(
        `SELECT a.action_type, a.entity_type, a.metadata, a.created_at, u.email as user_email, u.full_name as user_name
         FROM admin_audit_log a
         LEFT JOIN users u ON a.user_id = u.id
         ORDER BY a.created_at DESC
         LIMIT 20`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
         FROM lead_actions
         WHERE type IN ('ai_action', 'whatsapp', 'call')
           AND COALESCE(metadata->>'sender','') = 'AI'
           AND created_at > NOW() - INTERVAL '24 hours'`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c
         FROM lead_actions
         WHERE type = 'ai_action'
           AND outcome IN ('human_takeover', 'automation_call_failed', 'automation_whatsapp_failed')
           AND created_at > NOW() - INTERVAL '24 hours'`
      ),
    ]);

    const waTotal = Number(waHealthRes.rows[0]?.total || 0);
    const waFailed = Number(waHealthRes.rows[0]?.failed || 0);
    const callTotal = Number(callHealthRes.rows[0]?.total || 0);
    const callFailed = Number(callHealthRes.rows[0]?.failed || 0);
    const waSuccessRate = waTotal > 0 ? Number((((waTotal - waFailed) / waTotal) * 100).toFixed(1)) : 100;
    const callSuccessRate = callTotal > 0 ? Number((((callTotal - callFailed) / callTotal) * 100).toFixed(1)) : 100;

    res.json({
      commandCenter: {
        liveOverview: {
          platformStatus: waSuccessRate >= 95 && callSuccessRate >= 95 ? 'healthy' : 'degraded',
          activeUsers: Number(usersCount.rows[0]?.c || 0),
        },
        revenueSnapshot: {
          collected: Math.abs(Number(revenueRes.rows[0]?.v || 0)),
        },
        activeSubscriptions: Number(activeSubsRes.rows[0]?.c || 0),
        aiPerformance: {
          aiHandled24h: Number(aiActionsRes.rows[0]?.c || 0),
          humanEscalations24h: Number(humanEscalationsRes.rows[0]?.c || 0),
        },
        communicationHealth: {
          whatsappSuccessRate: waSuccessRate,
          callSuccessRate: callSuccessRate,
        },
        enterpriseAlerts: Number(enterpriseAlertsRes.rows[0]?.c || 0),
        criticalAlerts: Number(criticalAlertsRes.rows[0]?.c || 0),
        liveActivityFeed: recentActivity.rows || [],
        aiInsights: [
          waSuccessRate < 95
            ? 'WhatsApp failure rate increased; verify Meta token validity and template quality.'
            : 'WhatsApp delivery health is stable.',
          callSuccessRate < 95
            ? 'Call failures detected; verify Tata provider status and call-window routing.'
            : 'Calling system is operating within acceptable thresholds.',
        ],
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Communications Control ───────────────────────────────────────────────────
exports.getCommunicationsOverview = async (req, res, next) => {
  try {
    const [whatsappStats, callStats, failedDeliveries, providerAlerts] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome IN ('whatsapp_send_failed','automation_whatsapp_failed') THEN 1 ELSE 0 END)::int AS failed
         FROM lead_actions
         WHERE type = 'whatsapp'
           AND created_at > NOW() - INTERVAL '7 days'`
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN outcome = 'automation_call_failed' THEN 1 ELSE 0 END)::int AS failed
         FROM lead_actions
         WHERE type = 'call'
           AND created_at > NOW() - INTERVAL '7 days'`
      ),
      pool.query(
        `SELECT id, type, title, COALESCE(message, body, title) AS message, created_at
         FROM notifications
         WHERE type IN ('sales_automation', 'communication', 'whatsapp')
           AND created_at > NOW() - INTERVAL '7 days'
         ORDER BY created_at DESC
         LIMIT 20`
      ),
      pool.query(
        `SELECT action_type, entity_type, metadata, created_at
         FROM admin_audit_log
         WHERE action_type IN ('UPDATE_PLATFORM_CONFIG', 'UPDATE_AI_CONTROL')
         ORDER BY created_at DESC
         LIMIT 10`
      ),
    ]);

    const waTotal = Number(whatsappStats.rows[0]?.total || 0);
    const waFailed = Number(whatsappStats.rows[0]?.failed || 0);
    const callTotal = Number(callStats.rows[0]?.total || 0);
    const callFailed = Number(callStats.rows[0]?.failed || 0);

    res.json({
      communications: {
        whatsapp: {
          total7d: waTotal,
          failed7d: waFailed,
          successRate: waTotal > 0 ? Number((((waTotal - waFailed) / waTotal) * 100).toFixed(1)) : 100,
        },
        calling: {
          total7d: callTotal,
          failed7d: callFailed,
          successRate: callTotal > 0 ? Number((((callTotal - callFailed) / callTotal) * 100).toFixed(1)) : 100,
        },
        failedDeliveries: failedDeliveries.rows || [],
        providerStatusEvents: providerAlerts.rows || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Business Sources ─────────────────────────────────────────────────────────
exports.getBusinessSourcesOverview = async (req, res, next) => {
  try {
    const leadSources = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source,
         COUNT(*)::int AS leads,
         SUM(CASE WHEN stage = 'closed_won' THEN 1 ELSE 0 END)::int AS converted,
         SUM(CASE WHEN stage = 'closed_lost' THEN 1 ELSE 0 END)::int AS lost
       FROM leads
       GROUP BY 1
       ORDER BY leads DESC
       LIMIT 50`
    );
    const topPartners = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(source), ''), 'unknown') AS source,
         COUNT(*)::int AS total
       FROM leads
       WHERE created_at > NOW() - INTERVAL '90 days'
       GROUP BY 1
       ORDER BY total DESC
       LIMIT 10`
    );
    res.json({
      businessSources: {
        sourceAnalytics: leadSources.rows || [],
        partnerRankings: topPartners.rows || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Enterprise ───────────────────────────────────────────────────────────────
exports.getEnterpriseOverview = async (req, res, next) => {
  try {
    const [enterpriseLeads, enterpriseAlerts, enterpriseSubs] = await Promise.all([
      pool.query(
        `SELECT id, contact_first_name, contact_last_name, company_name, source, stage, created_at
         FROM leads
         WHERE LOWER(COALESCE(source, '')) LIKE '%enterprise%'
            OR LOWER(COALESCE(company_name, '')) LIKE '%enterprise%'
         ORDER BY created_at DESC
         LIMIT 100`
      ),
      pool.query(
        `SELECT id, title, COALESCE(message, body, title) AS message, read, created_at
         FROM notifications
         WHERE type = 'enterprise'
         ORDER BY created_at DESC
         LIMIT 50`
      ),
      pool.query(
        `SELECT s.id, s.module, s.status, s.created_at, o.name AS organization_name
         FROM subscriptions s
         JOIN organizations o ON o.id = s.org_id
         WHERE s.module IN ('salespal360')
         ORDER BY s.created_at DESC
         LIMIT 100`
      ),
    ]);
    res.json({
      enterprise: {
        requests: enterpriseLeads.rows || [],
        alerts: enterpriseAlerts.rows || [],
        billing: enterpriseSubs.rows || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Support Ops ──────────────────────────────────────────────────────────────
exports.getSupportOpsOverview = async (req, res, next) => {
  try {
    const tableProbe = await pool.query(`SELECT to_regclass('public.tickets') AS t`);
    const hasTickets = Boolean(tableProbe.rows[0]?.t);
    if (!hasTickets) {
      return res.json({
        supportOps: {
          totals: { total: 0, open: 0, critical: 0, closed: 0 },
          aiResolutionRate: 0,
          slaHoursAvg: 0,
          recent: [],
        },
      });
    }

    const [totals, aiRate, sla, recent] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END)::int AS open,
           SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END)::int AS critical,
           SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END)::int AS closed
         FROM tickets`
      ),
      pool.query(
        `SELECT
           CASE WHEN COUNT(*) = 0 THEN 0
                ELSE ROUND((SUM(CASE WHEN LOWER(COALESCE(metadata->>'resolvedBy','')) = 'ai' THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric) * 100, 1)
           END AS ai_resolution_rate
         FROM tickets
         WHERE status = 'closed'`
      ),
      pool.query(
        `SELECT
           COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 3600.0)::numeric, 2), 0) AS sla_hours_avg
         FROM tickets
         WHERE status = 'closed'`
      ),
      pool.query(
        `SELECT id, subject, priority, status, category, created_at, updated_at
         FROM tickets
         ORDER BY created_at DESC
         LIMIT 50`
      ),
    ]);

    res.json({
      supportOps: {
        totals: totals.rows[0] || { total: 0, open: 0, critical: 0, closed: 0 },
        aiResolutionRate: Number(aiRate.rows[0]?.ai_resolution_rate || 0),
        slaHoursAvg: Number(sla.rows[0]?.sla_hours_avg || 0),
        recent: recent.rows || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─── Alerts Center ────────────────────────────────────────────────────────────
exports.getAlertsOverview = async (req, res, next) => {
  try {
    const [critical, ai, comms, security] = await Promise.all([
      pool.query(
        `SELECT id, type, title, COALESCE(message, body, title) AS message, read, metadata, created_at
         FROM notifications
         WHERE created_at > NOW() - INTERVAL '14 days'
           AND type IN ('sales_automation', 'billing', 'enterprise', 'security')
         ORDER BY created_at DESC
         LIMIT 50`
      ),
      pool.query(
        `SELECT id, action_type, entity_type, metadata, created_at
         FROM admin_audit_log
         WHERE action_type IN ('UPDATE_AI_CONTROL')
         ORDER BY created_at DESC
         LIMIT 20`
      ),
      pool.query(
        `SELECT id, type, title, COALESCE(message, body, title) AS message, read, metadata, created_at
         FROM notifications
         WHERE created_at > NOW() - INTERVAL '14 days'
           AND type IN ('communication', 'whatsapp', 'sales_automation')
         ORDER BY created_at DESC
         LIMIT 50`
      ),
      pool.query(
        `SELECT id, action_type, entity_type, metadata, created_at
         FROM admin_audit_log
         WHERE action_type IN ('FORCE_LOGOUT', 'UPDATE_USER_STATUS')
         ORDER BY created_at DESC
         LIMIT 20`
      ),
    ]);

    res.json({
      alerts: {
        critical: critical.rows || [],
        ai: ai.rows || [],
        communications: comms.rows || [],
        security: security.rows || [],
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.acknowledgeAlert = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE notifications SET read = true WHERE id = $1 RETURNING id, title', [id]);
    if (result.rows.length === 0) return res.status(404).json({ message: 'Alert not found' });
    await logAudit(req, 'ACKNOWLEDGE_ALERT', 'ALERT', id, { title: result.rows[0]?.title || null });
    res.json({ message: 'Alert acknowledged', alertId: id });
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

// ─── AI Control ────────────────────────────────────────────────────────────────
exports.getAiControl = async (req, res, next) => {
  try {
    const config = await getSettingJson('ai_control_config', {
      llmProvider: 'gemini',
      imageProvider: 'flux',
      videoProvider: 'kling',
      voiceProvider: 'sarvam',
      fallbackEnabled: true,
      promptPolicy: 'project-first',
      escalationMode: 'ai_first',
      mediaQuality: 'hd',
      creditConsumptionRules: {
        text: 1,
        image: 5,
        video: 20,
        voiceMinute: 3,
      },
    });
    const usageRes = await pool.query(
      `SELECT
         COUNT(*)::int AS total_ai_actions,
         SUM(CASE WHEN type = 'ai_action' THEN 1 ELSE 0 END)::int AS action_rows,
         SUM(CASE WHEN outcome IN ('automation_whatsapp_failed','automation_call_failed') THEN 1 ELSE 0 END)::int AS failures
       FROM lead_actions
       WHERE created_at > NOW() - INTERVAL '30 days'`
    );
    res.json({
      aiControl: {
        config,
        usage: usageRes.rows[0] || { total_ai_actions: 0, action_rows: 0, failures: 0 },
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.updateAiControl = async (req, res, next) => {
  try {
    const config = req.body?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ message: 'config object is required' });
    }
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ('ai_control_config', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1, updated_by = $2, updated_at = NOW()`,
      [JSON.stringify(config), req.user.id]
    );
    await logAudit(req, 'UPDATE_AI_CONTROL', 'SYSTEM', null, config);
    res.json({ message: 'AI control updated', config });
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

exports.listActiveSessions = async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.user_id, r.created_at, r.expires_at, r.revoked, u.email, u.full_name, u.role, COALESCE(u.status, 'active') AS status
       FROM refresh_tokens r
       JOIN users u ON u.id = r.user_id
       WHERE r.revoked = false
         AND r.expires_at > NOW()
       ORDER BY r.created_at DESC
       LIMIT 200`
    );
    res.json({ sessions: result.rows });
  } catch (error) {
    next(error);
  }
};

exports.revokeSession = async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE refresh_tokens SET revoked = true WHERE id = $1 RETURNING id, user_id',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ message: 'Session not found' });
    await logAudit(req, 'REVOKE_SESSION', 'SESSION', id, { userId: result.rows[0].user_id });
    res.json({ message: 'Session revoked', sessionId: id });
  } catch (error) {
    next(error);
  }
};
