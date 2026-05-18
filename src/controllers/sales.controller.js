const db = require('../config/db');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const aiRuntime = require('../services/aiRuntime.service');
const aiService = require('../services/ai.service');
const whatsappService = require('../services/whatsapp.service');
const callComplianceService = require('../services/callCompliance.service');
const tataVoiceService = require('../services/tataVoice.service');
const salesEngagement = require('../services/salesEngagement.service');
const { retrieveTopKSql } = require('../services/projectKnowledge.service');

async function getOrgId(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

const STAGE_MAP = {
  new: 'new',
  contacted: 'contacted',
  qualified: 'qualified',
  proposal: 'proposal',
  closed_won: 'closed_won',
  won: 'closed_won',
  converted: 'closed_won',
  closed_lost: 'closed_lost',
  lost: 'closed_lost',
};

function normalizeLeadStage(stage) {
  if (!stage) return 'new';
  return STAGE_MAP[String(stage).trim().toLowerCase()] || 'new';
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim();
}

function isValidEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function isValidPhone(phone) {
  const cleaned = normalizePhone(phone).replace(/^\+/, '');
  return /^\d{7,15}$/.test(cleaned);
}

// ─── Leads (formerly "deals") ─────────────────────────────────────────────────

async function listDeals(req, res, next) {
  try {
    const { stage, assignedTo, limit = 50, offset = 0 } = req.query;
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    let sql = `SELECT * FROM leads WHERE org_id = $1`;
    const params = [orgId];
    let idx = 2;

    if (stage) { sql += ` AND stage = $${idx++}`; params.push(stage); }
    if (assignedTo) { sql += ` AND assigned_to = $${idx++}`; params.push(assignedTo); }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getDeal(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM leads WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createDeal(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const {
      contactFirstName, contact_first_name,
      contactLastName, contact_last_name,
      contactEmail, contact_email,
      contactPhone, contact_phone,
      companyName, company_name,
      stage,
      priority,
      value,
      source,
      assignedTo, assigned_to,
      aiScore, ai_score,
      notes,
      metadata,
      // Legacy field support
      title,
    } = req.body;

    const firstName = (contactFirstName || contact_first_name || title || '').toString().trim();
    const lastName = (contactLastName || contact_last_name || '').toString().trim();
    const email = (contactEmail || contact_email || '').toString().trim().toLowerCase();
    const phone = normalizePhone(contactPhone || contact_phone || '');

    if (!firstName) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Lead name is required' } });
    }
    if (!phone) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Phone is required' } });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Phone number must be 7 to 15 digits' } });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Email is invalid' } });
    }

    const duplicateParams = [orgId, phone];
    let duplicateSql = `SELECT id FROM leads WHERE org_id = $1 AND contact_phone = $2`;
    if (email) {
      duplicateSql += ` OR (org_id = $1 AND LOWER(contact_email) = $3)`;
      duplicateParams.push(email);
    }
    duplicateSql += ` LIMIT 1`;

    const duplicate = await db.query(duplicateSql, duplicateParams);
    if (duplicate.rows[0]) {
      return res.status(409).json({
        error: {
          code: 'DUPLICATE_LEAD',
          message: 'A lead with the same phone or email already exists.',
        },
      });
    }

    const { rows } = await db.query(
      `INSERT INTO leads
         (org_id, user_id, contact_first_name, contact_last_name, contact_email, contact_phone,
          company_name, stage, priority, value, source, assigned_to, ai_score, notes, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        orgId,
        req.user.id,
        firstName || null,
        lastName || null,
        email || null,
        phone || null,
        companyName      || company_name        || null,
        normalizeLeadStage(stage),
        priority         || 'medium',
        value            || 0,
        source           || 'Manual',
        assignedTo       || assigned_to         || null,
        aiScore          || ai_score            || null,
        notes            || null,
        metadata ? JSON.stringify(metadata) : '{}',
      ]
    );
    const lead = rows[0];
    try {
      await salesEngagement.getOrCreateSession({
        orgId,
        leadId: lead.id,
        userId: req.user.id,
        leadRow: lead,
      });
    } catch (e) {
      logger.warn('[sales-engagement] session on lead create skipped', { error: e.message });
    }
    res.status(201).json(lead);
  } catch (err) {
    next(err);
  }
}

async function updateDeal(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const allowed = {
      contactFirstName: 'contact_first_name',
      contact_first_name: 'contact_first_name',
      contactLastName: 'contact_last_name',
      contact_last_name: 'contact_last_name',
      contactEmail: 'contact_email',
      contact_email: 'contact_email',
      contactPhone: 'contact_phone',
      contact_phone: 'contact_phone',
      companyName: 'company_name',
      company_name: 'company_name',
      stage: 'stage',
      priority: 'priority',
      value: 'value',
      source: 'source',
      assignedTo: 'assigned_to',
      assigned_to: 'assigned_to',
      aiScore: 'ai_score',
      ai_score: 'ai_score',
      notes: 'notes',
      metadata: 'metadata',
    };

    const sets = [];
    const vals = [];
    let idx = 1;
    const seen = new Set();

    for (const [key, col] of Object.entries(allowed)) {
      if (req.body[key] !== undefined && !seen.has(col)) {
        seen.add(col);
        sets.push(`${col} = $${idx++}`);
        if (col === 'metadata') {
          vals.push(JSON.stringify(req.body[key]));
        } else if (col === 'stage') {
          vals.push(normalizeLeadStage(req.body[key]));
        } else {
          vals.push(req.body[key]);
        }
      }
    }

    if (sets.length === 0) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });

    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id, orgId);

    const { rows } = await db.query(
      `UPDATE leads SET ${sets.join(', ')} WHERE id = $${idx++} AND org_id = $${idx} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function deleteDeal(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rowCount } = await db.query(
      `DELETE FROM leads WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    res.json({ message: 'Lead deleted' });
  } catch (err) {
    next(err);
  }
}

// ─── Activities ───────────────────────────────────────────────────────────────

async function listActivities(req, res, next) {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    const { rows } = await db.query(
      `SELECT la.*, l.contact_first_name, l.contact_last_name, l.company_name
       FROM lead_actions la
       JOIN leads l ON l.id = la.lead_id
       WHERE l.org_id = $1
       ORDER BY la.created_at DESC
       LIMIT $2 OFFSET $3`,
      [orgId, parseInt(limit), parseInt(offset)]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

// ─── Sales Campaigns ──────────────────────────────────────────────────────────

async function createSalesCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { name, platform, source, description, projectId, project_id } = req.body;

    const { rows } = await db.query(
      `INSERT INTO campaigns (org_id, user_id, project_id, name, status, platform, metadata, created_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7)
       RETURNING *`,
      [
        orgId,
        req.user.id,
        projectId || project_id || null,
        name,
        platform || null,
        JSON.stringify({ created_from: 'sales', source: source || 'Manual', description: description || null }),
        req.user.id,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function listCampaignLeads(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ leads: [] });

    const { rows } = await db.query(
      `SELECT * FROM campaign_leads WHERE org_id = $1 AND campaign_id = $2 ORDER BY created_at DESC`,
      [orgId, req.params.campaignId]
    );
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
}

async function addCampaignLead(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows: campRows } = await db.query(
      `SELECT id FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [req.params.campaignId, orgId]
    );
    if (!campRows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    const { name, phone, email } = req.body;

    const { rows } = await db.query(
      `INSERT INTO campaign_leads
         (org_id, campaign_id, user_id, name, phone, email, source, ai_score_label, status, last_activity)
       VALUES ($1, $2, $3, $4, $5, $6, 'Manual', 'Warm', 'new', NOW())
       RETURNING *`,
      [orgId, req.params.campaignId, req.user.id, name, phone, email || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function deleteCampaignLead(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rowCount } = await db.query(
      `DELETE FROM campaign_leads
       WHERE id = $1 AND campaign_id = $2 AND org_id = $3`,
      [req.params.leadId, req.params.campaignId, orgId]
    );
    if (!rowCount) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign lead not found' } });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

const LEAD_ACTION_TYPES = new Set(['call', 'whatsapp', 'email', 'note', 'meeting', 'ai_action']);

function parseDurationSecondsFromLabel(label) {
  if (label == null) return null;
  const s = String(label);
  const m = s.match(/(\d+)\s*m\s*(\d+)/i);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const sec = s.match(/(\d+)\s*s/i);
  if (sec) return parseInt(sec[1], 10);
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function resolveHourMinute(hour, minute, ampm) {
  let hh = Number(hour || 0);
  const mm = Number(minute || 0);
  const ap = String(ampm || '').toLowerCase();
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return { hh, mm };
}

function tzOffsetMs(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

function zonedDateToUtcIso(year, month, day, hh, mm, timeZone) {
  const naiveUtc = Date.UTC(year, month - 1, day, hh, mm, 0);
  const probe = new Date(naiveUtc);
  const offset = tzOffsetMs(probe, timeZone);
  return new Date(naiveUtc - offset).toISOString();
}

function parseTimeToHourMinute(value, fallbackHour) {
  const m = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return { hh: fallbackHour, mm: 0 };
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

function formatWindowTimeLabel(windowPart) {
  const hh = Number(windowPart?.hh || 0);
  const mm = Number(windowPart?.mm || 0);
  const d = new Date(Date.UTC(2000, 0, 1, hh, mm, 0));
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

async function getUserSalesCallWindow(userId) {
  const { rows } = await db.query(
    `SELECT metadata->'settings'->'sales' AS sales
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const sales = rows[0]?.sales && typeof rows[0].sales === 'object' ? rows[0].sales : {};
  const start = parseTimeToHourMinute(sales.callStart, DEFAULT_CALL_WINDOW_START_HOUR);
  const end = parseTimeToHourMinute(sales.callEnd, DEFAULT_CALL_WINDOW_END_HOUR);
  return { start, end };
}

async function getUserHumanPersona(userId) {
  const { rows } = await db.query(
    `SELECT metadata->'settings'->'sales' AS sales
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const sales = rows[0]?.sales && typeof rows[0].sales === 'object' ? rows[0].sales : {};
  return aiService.normalizeHumanPersonaPreset(sales.aiPersona || 'friendly_consultant');
}

function mapSalesAiLangToLocale(aiLang) {
  const key = String(aiLang || 'English').trim();
  const m = {
    English: 'en',
    Hindi: 'hi',
    Gujarati: 'gu',
    Marathi: 'mr',
    Tamil: 'ta',
    Telugu: 'te',
  };
  return m[key] || 'hing';
}

async function getUserSalesAutomationLanguageSettings(userId) {
  try {
    const { rows } = await db.query(
      `SELECT metadata->'settings'->'sales' AS sales FROM users WHERE id = $1 LIMIT 1`,
      [userId]
    );
    const sales = rows[0]?.sales && typeof rows[0].sales === 'object' ? rows[0].sales : {};
    const mirror = sales.automationMirrorCustomerLanguage !== false;
    const aiLang = String(sales.aiLang || 'English').trim();
    return { mirror, aiLang };
  } catch {
    return { mirror: true, aiLang: 'English' };
  }
}

const DEFAULT_CALL_WINDOW_START_HOUR = 9;
const DEFAULT_CALL_WINDOW_END_HOUR = 21; // exclusive
const OUTBOUND_DND_START_HOUR = 21;
const OUTBOUND_DND_END_HOUR = 9;
const WHATSAPP_MAX_RETRY_ATTEMPTS = 4;
const WHATSAPP_DAY1_RETRY_GAP_MS = 7 * 60 * 60 * 1000; // ~6-8 hours
const WHATSAPP_LATER_RETRY_GAP_MS = 48 * 60 * 60 * 1000; // day3/day5 pattern
const LOST_EVAL_DELAY_MS = 48 * 60 * 60 * 1000;

function getZonedParts(dateInput, timeZone = 'Asia/Kolkata') {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  return parts.reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
}

function isWithinCallWindow(scheduleAt, timeZone = 'Asia/Kolkata', callWindow = null) {
  const z = getZonedParts(scheduleAt, timeZone);
  const hh = Number(z.hour || 0);
  const mm = Number(z.minute || 0);
  const nowTotal = hh * 60 + mm;
  const startObj = callWindow?.start || { hh: DEFAULT_CALL_WINDOW_START_HOUR, mm: 0 };
  const endObj = callWindow?.end || { hh: DEFAULT_CALL_WINDOW_END_HOUR, mm: 0 };
  const startTotal = Number(startObj.hh || 0) * 60 + Number(startObj.mm || 0);
  const endTotal = Number(endObj.hh || 0) * 60 + Number(endObj.mm || 0);
  if (startTotal < endTotal) return nowTotal >= startTotal && nowTotal < endTotal;
  if (startTotal > endTotal) return nowTotal >= startTotal || nowTotal < endTotal;
  return true;
}

function nextAvailableCallIso(scheduleAt, timeZone = 'Asia/Kolkata', callWindow = null) {
  const z = getZonedParts(scheduleAt, timeZone);
  const y = Number(z.year);
  const m = Number(z.month);
  const d = Number(z.day);
  const hh = Number(z.hour || 0);
  const mm = Number(z.minute || 0);
  const nowTotal = hh * 60 + mm;
  const startObj = callWindow?.start || { hh: DEFAULT_CALL_WINDOW_START_HOUR, mm: 0 };
  const endObj = callWindow?.end || { hh: DEFAULT_CALL_WINDOW_END_HOUR, mm: 0 };
  const startTotal = Number(startObj.hh || 0) * 60 + Number(startObj.mm || 0);
  const endTotal = Number(endObj.hh || 0) * 60 + Number(endObj.mm || 0);
  if (startTotal === endTotal) return new Date(scheduleAt).toISOString();
  if (startTotal < endTotal && nowTotal < startTotal) {
    return zonedDateToUtcIso(y, m, d, startObj.hh, startObj.mm, timeZone);
  }
  if (startTotal > endTotal && nowTotal < endTotal) {
    return new Date(scheduleAt).toISOString();
  }
  return zonedDateToUtcIso(y, m, d + 1, startObj.hh, startObj.mm, timeZone);
}

function isWithinOutboundWindow(scheduleAt, timeZone = 'Asia/Kolkata') {
  const z = getZonedParts(scheduleAt, timeZone);
  const hh = Number(z.hour || 0);
  return hh >= OUTBOUND_DND_END_HOUR && hh < OUTBOUND_DND_START_HOUR;
}

function nextAvailableOutboundIso(scheduleAt, timeZone = 'Asia/Kolkata') {
  const z = getZonedParts(scheduleAt, timeZone);
  const y = Number(z.year);
  const m = Number(z.month);
  const d = Number(z.day);
  const hh = Number(z.hour || 0);
  if (hh < OUTBOUND_DND_END_HOUR) {
    return zonedDateToUtcIso(y, m, d, OUTBOUND_DND_END_HOUR, 0, timeZone);
  }
  return zonedDateToUtcIso(y, m, d + 1, OUTBOUND_DND_END_HOUR, 0, timeZone);
}

function containsStopIntent(text) {
  const t = String(text || '').toLowerCase();
  return /\b(stop|unsubscribe|opt[\s-]?out|do not message|don't message|block)\b/.test(t);
}

function containsHumanHelpIntent(text) {
  const t = String(text || '').toLowerCase();
  return /\b(human|agent|call me|representative|manager|owner|person)\b/.test(t);
}

function nextRetryAtIso(baseIso, attemptNumber, leadTimezone) {
  const baseTs = new Date(baseIso).getTime();
  if (!Number.isFinite(baseTs)) return new Date(Date.now() + WHATSAPP_DAY1_RETRY_GAP_MS).toISOString();
  const attempt = Number(attemptNumber || 1);
  const plusMs = attempt <= 2 ? WHATSAPP_DAY1_RETRY_GAP_MS : WHATSAPP_LATER_RETRY_GAP_MS;
  const nextIso = new Date(baseTs + plusMs).toISOString();
  if (isWithinOutboundWindow(nextIso, leadTimezone)) return nextIso;
  return nextAvailableOutboundIso(nextIso, leadTimezone);
}

function normalizeSinceIso(value) {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? new Date(ts).toISOString() : new Date(0).toISOString();
  }
  const ts = new Date(String(value)).getTime();
  if (!Number.isFinite(ts)) return new Date(0).toISOString();
  return new Date(ts).toISOString();
}

function whatsappFailureSummary(prefix, err) {
  const code = String(err?.providerCode || err?.code || '').trim();
  const msg = String(err?.message || 'Unknown error').trim();
  const codePart = code ? ` (${code})` : '';
  return `${prefix}${codePart}: ${msg}`.slice(0, 800);
}

async function hasInboundReplySince({ leadId, sinceIso }) {
  const { rows } = await db.query(
    `SELECT 1
     FROM lead_actions
     WHERE lead_id = $1
       AND type = 'whatsapp'
       AND COALESCE(metadata->>'sender', '') = 'Lead'
       AND created_at >= $2::timestamptz
     LIMIT 1`,
    [leadId, sinceIso]
  );
  return Boolean(rows[0]);
}

async function summarizeOutboundDeliverySince({ leadId, sinceIso }) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       SUM(CASE WHEN COALESCE(metadata->'delivery'->>'status','') IN ('single_tick','sent') THEN 1 ELSE 0 END)::int AS pending_delivery,
       SUM(CASE WHEN COALESCE(metadata->'delivery'->>'status','') IN ('delivered','read') THEN 1 ELSE 0 END)::int AS delivered_or_read
     FROM lead_actions
     WHERE lead_id = $1
       AND type = 'whatsapp'
       AND COALESCE(metadata->>'sender', '') <> 'Lead'
       AND created_at >= $2::timestamptz`,
    [leadId, sinceIso]
  );
  return rows[0] || { total: 0, pending_delivery: 0, delivered_or_read: 0 };
}

async function appendLeadAction({ leadId, userId, type, content, outcome, metadata }) {
  await db.query(
    `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [leadId, userId, type, content, outcome, JSON.stringify(metadata || {})]
  );
}

async function getOwnerReportSettings(userId) {
  const { rows } = await db.query(
    `SELECT metadata->'settings' AS settings
     FROM users
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const settings = rows[0]?.settings && typeof rows[0].settings === 'object' ? rows[0].settings : {};
  const rpt = settings.ownerWhatsAppReports && typeof settings.ownerWhatsAppReports === 'object'
    ? settings.ownerWhatsAppReports
    : {};
  return {
    morningEnabled: rpt.morningEnabled !== false,
    eveningEnabled: rpt.eveningEnabled !== false,
    timezone: String(rpt.timezone || env.leadScheduleDefaultTz || 'Asia/Kolkata'),
  };
}

function normalizeNameForMatch(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function resolveProjectForLead({ orgId, leadId, leadMetadata }) {
  const md = leadMetadata && typeof leadMetadata === 'object' ? leadMetadata : {};
  let projectId = String(md.projectId || md.project_id || '').trim();
  let project = null;
  let leadCompanyName = '';

  if (leadId) {
    const { rows: leadRows } = await db.query(
      `SELECT company_name, metadata FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [leadId, orgId]
    );
    const lead = leadRows[0];
    leadCompanyName = String(lead?.company_name || '').trim();
    const fromLead = lead?.metadata && typeof lead.metadata === 'object' ? lead.metadata : {};
    if (!projectId) projectId = String(fromLead.projectId || fromLead.project_id || '').trim();
    if (!md.projectName && fromLead.projectName) md.projectName = fromLead.projectName;
    if (!md.project_name && fromLead.project_name) md.project_name = fromLead.project_name;
  }

  if (projectId) {
    const { rows } = await db.query(
      `SELECT id, name, description FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [projectId, orgId]
    );
    project = rows[0] || null;
  }

  const hintedNames = [md.projectName, md.project_name, leadCompanyName]
    .map((x) => String(x || '').trim())
    .filter(Boolean);

  if (!project && hintedNames.length) {
    const { rows } = await db.query(`SELECT id, name, description FROM projects WHERE org_id = $1 LIMIT 300`, [orgId]);
    const candidates = rows || [];
    for (const hint of hintedNames) {
      const normalizedHint = normalizeNameForMatch(hint);
      if (!normalizedHint) continue;
      const exact = candidates.find((p) => normalizeNameForMatch(p.name) === normalizedHint);
      if (exact) {
        project = exact;
        break;
      }
      const includes = candidates.find(
        (p) =>
          normalizeNameForMatch(p.name).includes(normalizedHint) ||
          normalizedHint.includes(normalizeNameForMatch(p.name))
      );
      if (includes) {
        project = includes;
        break;
      }
    }
  }

  return project || null;
}

async function buildLeadProjectKnowledgePrompt({ orgId, leadId, leadMetadata, queryText }) {
  const project = await resolveProjectForLead({ orgId, leadId, leadMetadata });
  const projectId = String(project?.id || '').trim();
  if (!projectId) return '';

  const q = String(queryText || '').trim() || `${project.name || 'project'} overview pricing location`;
  const top = await retrieveTopKSql({ projectId, orgId, queryText: q, k: 8 });
  const contextLines = top
    .map((r) => `[${String(r.source_type || 'source')}] ${String(r.content || '').trim()}`)
    .filter(Boolean)
    .slice(0, 8);

  const pn = String(project.name || '').trim();
  const pd = String(project.description || '').trim().slice(0, 900);
  return [
    'PROJECT KNOWLEDGE MODE (STRICT):',
    pn ? `- Selected project: "${pn}"` : '- Selected project exists.',
    pd ? `- Project description:\n${pd}` : null,
    contextLines.length
      ? `- Brain Drive evidence excerpts (ground truth):\n${contextLines.join('\n---\n')}`
      : '- Brain Drive evidence excerpts: none indexed yet.',
    '- Reply about this project only (inventory, location, pricing, visit, process).',
    '- If asked anything outside this project, answer briefly then steer back to this project.',
    '- Never switch to generic SalesPal product marketing unless the lead explicitly asks about SalesPal software itself.',
    '- If specific project detail is not in evidence, clearly say it is not in indexed project materials and offer human follow-up.',
    '- If user says "about project X", prioritize that mapped project and avoid generic SalesPal pitch.',
  ]
    .filter(Boolean)
    .join('\n');
}

function parseNaturalScheduleAt(text, timeZone = 'Asia/Kolkata') {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const now = new Date();

  if (/\b(now|right now|immediately|immediate|asap|as soon as possible)\b/i.test(t)) {
    return new Date(now.getTime() + 20 * 1000).toISOString();
  }

  const inHours = t.match(/\b(?:in|after)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/i);
  if (inHours) {
    const n = Number(inHours[1] || 1);
    if (Number.isFinite(n) && n > 0) {
      return new Date(now.getTime() + n * 60 * 60 * 1000).toISOString();
    }
  }

  const inMins = t.match(/\b(?:in|after)\s+(\d{1,3})\s*(minute|minutes|min|mins)\b/i);
  if (inMins) {
    const n = Number(inMins[1] || 1);
    if (Number.isFinite(n) && n > 0) {
      return new Date(now.getTime() + n * 60 * 1000).toISOString();
    }
  }

  const dayOffset = /\btomorrow\b/i.test(t) ? 1 : 0;
  const tm = t.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (tm) {
    const hm = resolveHourMinute(tm[1], tm[2] || 0, tm[3] || '');
    if (hm) {
      const nowTz = new Date(now.toLocaleString('en-US', { timeZone }));
      const y = nowTz.getFullYear();
      const m = nowTz.getMonth() + 1;
      const d = nowTz.getDate() + dayOffset;
      let iso = zonedDateToUtcIso(y, m, d, hm.hh, hm.mm, timeZone);
      if (dayOffset === 0 && new Date(iso).getTime() < now.getTime()) {
        iso = zonedDateToUtcIso(y, m, d + 1, hm.hh, hm.mm, timeZone);
      }
      return iso;
    }
  }

  return null;
}

function inferHandshakeIntent({ type, content, metadata, leadTimezone }) {
  if (String(metadata?.sender || '').toLowerCase() === 'ai') {
    return null;
  }
  const text = String(content || '').toLowerCase();
  if (!text.trim()) return null;
  const asksCall = /(call|phone call|ring|voice call)/i.test(text);
  const asksChat = /(whatsapp|chat|message|text me|continue.*chat)/i.test(text);
  const when = parseNaturalScheduleAt(text, leadTimezone || 'Asia/Kolkata');
  if (!when) return null;

  if (type === 'whatsapp' && asksCall) {
    return { sourceChannel: 'whatsapp', targetChannel: 'call', scheduleAt: when };
  }
  if (type === 'call' && asksChat) {
    return { sourceChannel: 'call', targetChannel: 'whatsapp', scheduleAt: when };
  }
  if (type === 'call' && asksCall) {
    return { sourceChannel: 'call', targetChannel: 'call', scheduleAt: when };
  }
  if (type === 'whatsapp' && asksChat) {
    return { sourceChannel: 'whatsapp', targetChannel: 'whatsapp', scheduleAt: when };
  }
  return null;
}

function bucketIsoTo5Min(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const bucketMs = 5 * 60 * 1000;
  const bucket = Math.floor(d.getTime() / bucketMs) * bucketMs;
  return new Date(bucket).toISOString();
}

function buildAutomationFingerprint({ sourceChannel, targetChannel, scheduleAt, text }) {
  const normalizedText = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
  const bucket = bucketIsoTo5Min(scheduleAt);
  const raw = `${sourceChannel}|${targetChannel}|${bucket}|${normalizedText}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Append a timeline / communication event (persisted). Used by Sales workspace for calls, WhatsApp, bot routing.
 */
async function createLeadAction(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const leadId = req.params.id;
    const { type, content, outcome, durationSeconds, metadata } = req.body || {};

    if (!LEAD_ACTION_TYPES.has(type)) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: `type must be one of: ${[...LEAD_ACTION_TYPES].join(', ')}` },
      });
    }

    const { rows: leadRows } = await db.query(
      `SELECT id, contact_first_name, contact_last_name, contact_phone, metadata FROM leads WHERE id = $1 AND org_id = $2`,
      [leadId, orgId]
    );
    if (!leadRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });

    let dur =
      durationSeconds != null && Number.isFinite(Number(durationSeconds))
        ? Math.max(0, Math.floor(Number(durationSeconds)))
        : null;
    if (dur == null && metadata && typeof metadata === 'object' && metadata.duration != null) {
      dur = parseDurationSecondsFromLabel(metadata.duration);
    }

    const meta =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
    const metaJson = JSON.stringify(meta);

    const { rows } = await db.query(
      `INSERT INTO lead_actions (lead_id, user_id, type, content, duration_seconds, outcome, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        leadId,
        req.user.id,
        type,
        content != null ? String(content) : '',
        dur,
        outcome != null ? String(outcome) : null,
        metaJson,
      ]
    );

    let row = rows[0];
    if (type === 'whatsapp') {
      const sender = String(meta.sender || '').toLowerCase();
      const isHumanOutbound = sender === 'salesrep' || sender === 'human' || sender === 'owner';
      if (isHumanOutbound) {
        const takeoverUntilIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await db.query(
          `UPDATE leads
           SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
          [
            leadId,
            JSON.stringify({
              whatsappHumanTakeoverUntil: takeoverUntilIso,
              whatsappHumanTakeoverBy: req.user.id,
              whatsappHumanTakeoverMode: 'human',
            }),
          ]
        );
      }
    }
    if (type === 'whatsapp' && !meta.automationJobId && meta.sender !== 'Lead') {
      const text = String(content || '').trim();
      if (text && whatsappService.isWhatsAppEnabled()) {
        try {
          const sent = await whatsappService.sendWhatsAppText({
            to: leadRows[0]?.contact_phone,
            text,
          });
          const { rows: updatedRows } = await db.query(
            `UPDATE lead_actions
             SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
             WHERE id = $1
             RETURNING *`,
            [
              row.id,
              JSON.stringify({
                delivery: {
                  channel: 'whatsapp',
                  status: 'sent',
                  provider: sent.provider,
                  messageId: sent.messageId || null,
                },
              }),
            ]
          );
          row = updatedRows[0] || row;
        } catch (sendErr) {
          console.error('[whatsapp] direct send failed', {
            leadId,
            userId: req.user.id,
            code: sendErr?.code || null,
            providerCode: sendErr?.providerCode || null,
            statusCode: sendErr?.statusCode || null,
            message: sendErr?.message || '',
            traceId: sendErr?.providerTraceId || null,
          });
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'ai_action',$3,'whatsapp_send_failed',$4::jsonb)`,
            [
              leadId,
              req.user.id,
              whatsappFailureSummary('WhatsApp send failed', sendErr),
              JSON.stringify({
                title: 'WhatsApp Send Failed',
                error: sendErr?.message || 'Unknown error',
                errorCode: sendErr?.code || null,
                providerCode: sendErr?.providerCode || null,
                providerSubcode: sendErr?.providerSubcode || null,
                providerType: sendErr?.providerType || null,
                providerTraceId: sendErr?.providerTraceId || null,
                statusCode: sendErr?.statusCode || null,
              }),
            ]
          );
        }
      }
    }
    const lastLine = meta.title || outcome || type;
    await db.query(
      `UPDATE leads
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2 AND org_id = $3`,
      [
        JSON.stringify({
          lastInteraction: String(lastLine).slice(0, 500),
          lastActivityAt: new Date().toISOString(),
        }),
        leadId,
        orgId,
      ]
    );

    if (!meta.automationJobId && (type === 'call' || type === 'whatsapp')) {
      const leadTimezone = leadRows[0]?.metadata?.timezone || 'Asia/Kolkata';
      const callWindow = await getUserSalesCallWindow(req.user.id);
      const handshake = inferHandshakeIntent({ type, content, metadata: meta, leadTimezone });
      if (handshake) {
        if (handshake.targetChannel === 'call' && !isWithinCallWindow(handshake.scheduleAt, leadTimezone, callWindow)) {
          const suggestedIso = nextAvailableCallIso(handshake.scheduleAt, leadTimezone, callWindow);
          const requestedAt = new Date(handshake.scheduleAt).toLocaleString('en-US', { timeZone: leadTimezone });
          const suggestedAt = new Date(suggestedIso).toLocaleString('en-US', { timeZone: leadTimezone });
          const windowLabel = `${formatWindowTimeLabel(callWindow.start)} - ${formatWindowTimeLabel(callWindow.end)}`;
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'whatsapp',$3,'automation_outside_call_window',$4::jsonb)`,
            [
              leadId,
              req.user.id,
              `Requested call time ${requestedAt} is outside call hours (${windowLabel}). Next available slot: ${suggestedAt}.`,
              JSON.stringify({
                title: 'Call time unavailable',
                sender: 'AI',
                sourceChannel: handshake.sourceChannel,
                targetChannel: handshake.targetChannel,
                requestedScheduleAt: handshake.scheduleAt,
                suggestedScheduleAt: suggestedIso,
                timezone: leadTimezone,
              }),
            ]
          );
          return res.status(201).json(row);
        }
        const fingerprint = buildAutomationFingerprint({
          sourceChannel: handshake.sourceChannel,
          targetChannel: handshake.targetChannel,
          scheduleAt: handshake.scheduleAt,
          text: content,
        });
        const dedupe = await db.query(
          `SELECT id
           FROM sales_automation_jobs
           WHERE org_id = $1
             AND user_id = $2
             AND lead_id = $3
             AND fingerprint = $4
             AND source_channel = $5
             AND target_channel = $6
             AND status = 'pending'
             AND ABS(EXTRACT(EPOCH FROM (schedule_at - $7::timestamptz))) <= 300
           LIMIT 1`,
          [orgId, req.user.id, leadId, fingerprint, handshake.sourceChannel, handshake.targetChannel, handshake.scheduleAt]
        );
        if (dedupe.rows[0]) {
          return res.status(201).json(row);
        }
        const { rows: jobs } = await db.query(
          `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
           RETURNING *`,
          [
            orgId,
            req.user.id,
            leadId,
            handshake.sourceChannel,
            handshake.targetChannel,
            handshake.scheduleAt,
            JSON.stringify({
              inferred: true,
              inferredFromActionId: row.id,
              inferredFromText: String(content || '').slice(0, 300),
            }),
            fingerprint,
          ]
        ).catch((err) => {
          if (String(err?.message || '').includes('ux_sales_automation_jobs_pending_fingerprint')) {
            return { rows: [] };
          }
          throw err;
        });
        if (!jobs[0]) {
          return res.status(201).json(row);
        }
        const job = jobs[0];
        await db.query(
          `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
           VALUES ($1,$2,'ai_action',$3,'automation_scheduled',$4::jsonb)`,
          [
            leadId,
            req.user.id,
            `Auto-scheduled ${job.target_channel} follow-up at ${new Date(job.schedule_at).toLocaleString()}`,
            JSON.stringify({
              title: 'Auto Handshake Scheduled',
              sourceChannel: job.source_channel,
              targetChannel: job.target_channel,
              scheduleAt: job.schedule_at,
              automationJobId: job.id,
              fingerprint,
            }),
          ]
        );
      }
    }

    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

async function listLeadActions(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    const leadId = req.params.id;
    const { rows: leadRows } = await db.query(`SELECT id FROM leads WHERE id = $1 AND org_id = $2`, [leadId, orgId]);
    if (!leadRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });

    const lim = parseInt(String(req.query.limit || '200'), 10);
    const limit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 500) : 200;
    const { rows } = await db.query(
      `SELECT *
       FROM (
         SELECT *
         FROM lead_actions
         WHERE lead_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) recent
       ORDER BY created_at ASC`,
      [leadId, limit]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function createAutomationJob(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const leadId = req.params.id;
    const { sourceChannel, targetChannel, scheduleAt, payload } = req.body || {};
    const scheduleDate = new Date(scheduleAt);
    if (Number.isNaN(scheduleDate.getTime())) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'scheduleAt is invalid' } });
    }
    const { rows: leadRows } = await db.query(`SELECT id, contact_first_name, contact_last_name, metadata FROM leads WHERE id = $1 AND org_id = $2`, [leadId, orgId]);
    if (!leadRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    const leadTimezone = leadRows[0]?.metadata?.timezone || 'Asia/Kolkata';
    const callWindow = await getUserSalesCallWindow(req.user.id);
    if (targetChannel === 'call' && !isWithinCallWindow(scheduleDate.toISOString(), leadTimezone, callWindow)) {
      const suggestedIso = nextAvailableCallIso(scheduleDate.toISOString(), leadTimezone, callWindow);
      const windowLabel = `${formatWindowTimeLabel(callWindow.start)} - ${formatWindowTimeLabel(callWindow.end)}`;
      return res.status(400).json({
        error: {
          code: 'CALL_WINDOW_UNAVAILABLE',
          message: `Call slots are available ${windowLabel} (${leadTimezone}). Suggested: ${new Date(suggestedIso).toLocaleString('en-US', { timeZone: leadTimezone })}`,
        },
        suggestion: {
          scheduleAt: suggestedIso,
          timezone: leadTimezone,
        },
      });
    }
    const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const fingerprint = buildAutomationFingerprint({
      sourceChannel,
      targetChannel,
      scheduleAt: scheduleDate.toISOString(),
      text: safePayload?.messageTemplate || `${sourceChannel}-${targetChannel}`,
    });
    const { rows } = await db.query(
      `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       RETURNING *`,
      [orgId, req.user.id, leadId, sourceChannel, targetChannel, scheduleDate.toISOString(), JSON.stringify(safePayload), fingerprint]
    ).catch((err) => {
      if (String(err?.message || '').includes('ux_sales_automation_jobs_pending_fingerprint')) {
        return { rows: [] };
      }
      throw err;
    });
    if (!rows[0]) {
      return res.status(200).json({ duplicate: true });
    }
    const row = rows[0];
    await db.query(
      `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
       VALUES ($1,$2,'ai_action',$3,'automation_scheduled',$4::jsonb)`,
      [
        leadId,
        req.user.id,
        `Bot automation scheduled for ${targetChannel} at ${scheduleDate.toLocaleString()}`,
        JSON.stringify({
          title: 'Automation Scheduled',
          scheduleAt: row.schedule_at,
          sourceChannel,
          targetChannel,
          automationJobId: row.id,
        }),
      ]
    );
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
}

async function dispatchDueAutomationJobs(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ dispatched: 0, jobs: [] });
    const callWindow = await getUserSalesCallWindow(req.user.id);
    const limit = Math.max(1, Math.min(100, Number(req.body?.limit || 25)));
    const { rows: jobs } = await db.query(
      `SELECT j.*, l.contact_first_name, l.contact_last_name, l.contact_phone, l.metadata
       FROM sales_automation_jobs j
       JOIN leads l ON l.id = j.lead_id
       WHERE j.org_id = $1 AND j.user_id = $2 AND j.status = 'pending' AND j.schedule_at <= NOW()
       ORDER BY j.schedule_at ASC
       LIMIT $3`,
      [orgId, req.user.id, limit]
    );
    const dispatchedJobs = [];
    for (const job of jobs) {
      const leadName = `${job.contact_first_name || ''} ${job.contact_last_name || ''}`.trim() || 'Lead';
      const leadMetadata = job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
      const leadTimezone = String(leadMetadata.timezone || leadMetadata.leadTimezone || 'Asia/Kolkata');
      const payloadObj = job.payload && typeof job.payload === 'object' ? job.payload : {};

      if (payloadObj.kind === 'lost_eval') {
        const sinceIso = normalizeSinceIso(payloadObj.sinceAt || job.created_at);
        const hasReply = await hasInboundReplySince({ leadId: job.lead_id, sinceIso });
        const delivery = await summarizeOutboundDeliverySince({
          leadId: job.lead_id,
          sinceIso,
        });
        const pendingDeliveryOnly =
          Number(delivery.total || 0) > 0 &&
          Number(delivery.pending_delivery || 0) > 0 &&
          Number(delivery.delivered_or_read || 0) === 0;
        if (!hasReply && pendingDeliveryOnly) {
          const { rows: latestLead } = await db.query(
            `SELECT stage, metadata FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`,
            [job.lead_id, orgId]
          );
          if (latestLead[0]) {
            const md = latestLead[0].metadata && typeof latestLead[0].metadata === 'object' ? latestLead[0].metadata : {};
            await db.query(
              `UPDATE leads
               SET stage = 'closed_lost',
                   metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                   updated_at = NOW()
               WHERE id = $1`,
              [
                job.lead_id,
                JSON.stringify({
                  ...md,
                  aiScoreLabel: 'Lost',
                  lostReason: 'whatsapp_no_response_after_retries_48h',
                  lastActivityAt: new Date().toISOString(),
                }),
              ]
            );
            await appendLeadAction({
              leadId: job.lead_id,
              userId: req.user.id,
              type: 'ai_action',
              content: 'Lead auto-marked as Lost after WhatsApp retry sequence and 48h wait.',
              outcome: 'lead_lost_retry_timeout',
              metadata: { title: 'Lead marked Lost (automation)', automationJobId: job.id },
            });
          }
        }
        const { rows: updatedEvalJob } = await db.query(
          `UPDATE sales_automation_jobs
           SET status = 'completed', dispatched_at = NOW(), updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [job.id]
        );
        if (updatedEvalJob[0]) dispatchedJobs.push(updatedEvalJob[0]);
        continue;
      }

      if (job.target_channel === 'call') {
        if (!isWithinCallWindow(job.schedule_at, leadTimezone, callWindow)) {
          const shiftedIso = nextAvailableCallIso(job.schedule_at, leadTimezone, callWindow);
          await db.query(
            `UPDATE sales_automation_jobs
             SET schedule_at = $2::timestamptz, updated_at = NOW()
             WHERE id = $1`,
            [job.id, shiftedIso]
          );
          continue;
        }
        try {
          const { rows: phoneRows } = await db.query(
            `SELECT contact_phone FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`,
            [job.lead_id, orgId]
          );
          const dialPhone =
            phoneRows[0]?.contact_phone != null ? String(phoneRows[0].contact_phone) : String(job.contact_phone || '');
          if (!hasDialableLeadPhone(dialPhone)) {
            const err = new Error(
              'Lead has no valid contact_phone on file; cannot place Tata outbound call. Re-save the campaign start (or edit the lead phone) so the queue picks up the list number, then try again.'
            );
            err.code = 'MISSING_DIAL_PHONE';
            throw err;
          }

          const { mirror: autoLangMirror, aiLang: fixedAiLang } = await getUserSalesAutomationLanguageSettings(
            req.user.id
          );
          const leadPref = String(leadMetadata.preferredLocale || 'hing').toLowerCase().trim() || 'hing';
          const openerLocale = autoLangMirror ? leadPref : mapSalesAiLangToLocale(fixedAiLang);
          const sessionLocale = autoLangMirror ? 'hing' : openerLocale;
          const projectId = leadMetadata.projectId || null;
          const agentName = leadMetadata.agentName || 'SalesPal AI';
          const tpl = (job.payload && typeof job.payload === 'object' && String(job.payload.messageTemplate || '').trim()) || '';
          const cont = (job.payload && typeof job.payload === 'object' && String(job.payload.voiceContinuationSnippet || '').trim()) || '';
          const openerContext = [tpl, cont ? `Callback context (prior voice session):\n${cont}` : '']
            .filter(Boolean)
            .join('\n\n');

          logger.info('[automation-dispatch] placing Tata voice session', {
            automationJobId: job.id,
            leadId: job.lead_id,
            payloadKind: payloadObj.kind || null,
            telephonyEnabled: tataVoiceService.isTelephonyEnabled(),
            phoneDigitsLen: digitsOnlyPhone(dialPhone).length,
          });

          await salesEngagement
            .getOrCreateSession({ orgId, leadId: job.lead_id, userId: req.user.id })
            .catch(() => null);
          await salesEngagement
            .applyEvent({
              leadId: job.lead_id,
              orgId,
              event: salesEngagement.ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED,
              channel: 'voice_pstn',
              metadata: { automationJobId: job.id, kind: payloadObj.kind || null },
            })
            .catch(() => {});

          const { session, telephony } = await aiRuntime.createVoiceSession({
            brandId: `web-${req.user.id}`,
            leadId: job.lead_id,
            phone: dialPhone,
            name: leadName,
            locale: sessionLocale,
            mode: 'automation',
            openerContext,
            projectId,
            agentName,
            orgId,
            userId: req.user.id,
            mirrorSpokenLanguage: autoLangMirror,
            openerTtsLocale: autoLangMirror ? openerLocale : null,
          });

          if (tataVoiceService.isTelephonyEnabled() && !telephony?.accepted) {
            const err = new Error(
              telephony?.reason ||
                'Tata did not accept the outbound call. Check TATA_* env vars, caller ID, and Smartflo Voice Bot routing.'
            );
            err.code = 'TATA_CALL_NOT_ACCEPTED';
            err.details = telephony;
            throw err;
          }

          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'call',$3,'automation_call_started',$4::jsonb)`,
            [
              job.lead_id,
              req.user.id,
              'Automated Tata AI call initiated for this lead.',
              JSON.stringify({
                title: 'Automation Call Started',
                automationJobId: job.id,
                conversationId: session.conversationId,
                telephony,
              }),
            ]
          );
          if (telephony?.enabled && telephony?.accepted) {
            await salesEngagement
              .applyEvent({
                leadId: job.lead_id,
                orgId,
                event: salesEngagement.ENGAGEMENT_EVENTS.CALL_CONNECTED,
                channel: 'voice_pstn',
                metadata: {
                  automationJobId: job.id,
                  conversationId: session.conversationId,
                  providerCallId: telephony?.providerCallId || null,
                },
                patch: { activeVoiceConversationId: session.conversationId },
              })
              .catch(() => {});
            const callPlacedMsg = telephony?.providerCallId
              ? `Tata accepted the bot call (Call ID: ${telephony.providerCallId}).`
              : 'Tata accepted the bot call request.';
            await db.query(
              `INSERT INTO notifications (user_id, org_id, type, title, message, body, read, metadata, created_at)
               VALUES ($1,$2,'sales_automation',$3,$4,$4,false,$5::jsonb,NOW())`,
              [
                req.user.id,
                orgId,
                'Tata call placed successfully',
                `${callPlacedMsg} Lead: ${leadName}`,
                JSON.stringify({
                  link: `/sales/leads/${job.lead_id}`,
                  priority: 'critical',
                  delivery_status: 'delivered',
                  automationJobId: job.id,
                  targetChannel: 'call',
                  provider: telephony?.provider || 'tata',
                  providerCallId: telephony?.providerCallId || null,
                }),
              ]
            );
          }

          const { rows: updatedCallJob } = await db.query(
            `UPDATE sales_automation_jobs
             SET status = 'completed', dispatched_at = NOW(), updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [job.id]
          );
          dispatchedJobs.push(updatedCallJob[0]);
          continue;
        } catch (err) {
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'ai_action',$3,'automation_call_failed',$4::jsonb)`,
            [
              job.lead_id,
              req.user.id,
              'Automated Tata call failed to start. Please verify telephony credentials and number format.',
              JSON.stringify({
                title: 'Automation Call Failed',
                automationJobId: job.id,
                error: err?.message || 'Unknown error',
                errorCode: err?.code || null,
              }),
            ]
          );
          // Fail closed to avoid infinite retries on misconfiguration.
          await db.query(
            `UPDATE sales_automation_jobs
             SET status = 'cancelled', updated_at = NOW()
             WHERE id = $1`,
            [job.id]
          );
          continue;
        }
      }

      if (job.target_channel === 'whatsapp') {
        if (!isWithinOutboundWindow(job.schedule_at, leadTimezone)) {
          const shiftedIso = nextAvailableOutboundIso(job.schedule_at, leadTimezone);
          await db.query(
            `UPDATE sales_automation_jobs
             SET schedule_at = $2::timestamptz, updated_at = NOW()
             WHERE id = $1`,
            [job.id, shiftedIso]
          );
          continue;
        }
        const hasReply = await hasInboundReplySince({ leadId: job.lead_id, sinceIso: normalizeSinceIso(job.created_at) });
        if (hasReply) {
          await db.query(
            `UPDATE sales_automation_jobs
             SET status = 'cancelled', updated_at = NOW()
             WHERE id = $1`,
            [job.id]
          );
          await appendLeadAction({
            leadId: job.lead_id,
            userId: req.user.id,
            type: 'ai_action',
            content: 'Stopped pending WhatsApp retries because lead replied.',
            outcome: 'automation_retry_stopped_on_reply',
            metadata: { title: 'Retries stopped', automationJobId: job.id },
          });
          continue;
        }
        if (Boolean(leadMetadata.whatsappOptOut)) {
          await db.query(
            `UPDATE sales_automation_jobs
             SET status = 'cancelled', updated_at = NOW()
             WHERE id = $1`,
            [job.id]
          );
          continue;
        }
        const requestedTemplate =
          String(payloadObj.messageTemplate || '').trim();
        let outboundText = requestedTemplate;
        if (!outboundText) {
          try {
            const { mirror: waAutoLangMirror, aiLang: waFixedAiLang } = await getUserSalesAutomationLanguageSettings(
              req.user.id
            );
            const leadPref = String(leadMetadata.preferredLocale || 'hing').toLowerCase().trim() || 'hing';
            const outboundLocaleForPrompt = waAutoLangMirror ? leadPref : mapSalesAiLangToLocale(waFixedAiLang);
            const humanPersona = await getUserHumanPersona(req.user.id).catch(() => 'friendly_consultant');
            const projectPrompt = await buildLeadProjectKnowledgePrompt({
              orgId,
              leadId: job.lead_id,
              leadMetadata,
              queryText: `WhatsApp follow-up for ${leadName}: ${String(payloadObj.contextHint || '')}`,
            });
            outboundText = await aiService.callAIWithMessages(
              [
                {
                  role: 'user',
                  content: `Write one concise WhatsApp follow-up message for ${leadName}. Keep it natural and ask one clear next-step question.`,
                },
              ],
              `${aiService.systemPromptForChat('whatsapp', {
                leadPreferredLocale: outboundLocaleForPrompt,
                humanPersona,
                automationOutboundFirstMessage: true,
              })}\n\n${projectPrompt}`,
              { temperature: 0.6 }
            );
          } catch (_) {
            outboundText = '';
          }
        }
        outboundText =
          String(outboundText || '').trim() ||
          `Hi ${leadName}, just following up from SalesPal. Would you like me to share the project details here on WhatsApp?`;

        if (whatsappService.isWhatsAppEnabled()) {
          try {
            const sent = await whatsappService.sendWhatsAppText({
              to: job.contact_phone,
              text: outboundText,
            });
            await db.query(
              `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
               VALUES ($1,$2,'whatsapp',$3,'automation_whatsapp_sent',$4::jsonb)`,
              [
                job.lead_id,
                req.user.id,
                outboundText,
                JSON.stringify({
                  title: 'Automation WhatsApp Sent',
                  automationJobId: job.id,
                  sourceChannel: job.source_channel,
                  targetChannel: job.target_channel,
                  sender: 'AI',
                  delivery: {
                    channel: 'whatsapp',
                    status: 'sent',
                    provider: sent.provider,
                    messageId: sent.messageId || null,
                  },
                }),
              ]
            );
            const { rows: updatedWaJob } = await db.query(
              `UPDATE sales_automation_jobs
               SET status = 'completed', dispatched_at = NOW(), updated_at = NOW()
               WHERE id = $1
               RETURNING *`,
              [job.id]
            );
            dispatchedJobs.push(updatedWaJob[0]);
            const retryAttempt = Number(payloadObj.retryAttempt || 0);
            const isFinalAttempt = retryAttempt >= WHATSAPP_MAX_RETRY_ATTEMPTS;
            if (!isFinalAttempt) {
              const nextAttempt = retryAttempt + 1;
              const nextScheduleAt = nextRetryAtIso(job.schedule_at, nextAttempt, leadTimezone);
              const retryFingerprint = buildAutomationFingerprint({
                sourceChannel: 'whatsapp',
                targetChannel: 'whatsapp',
                scheduleAt: nextScheduleAt,
                text: `${job.lead_id}:retry:${nextAttempt}`,
              });
              await db.query(
                `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
                 VALUES ($1,$2,$3,'whatsapp','whatsapp',$4,$5::jsonb,$6)
                 ON CONFLICT ON CONSTRAINT ux_sales_automation_jobs_pending_fingerprint DO NOTHING`,
                [
                  orgId,
                  req.user.id,
                  job.lead_id,
                  nextScheduleAt,
                  JSON.stringify({
                    ...payloadObj,
                    retryAttempt: nextAttempt,
                    retryParentJobId: job.id,
                    messageTemplate: '',
                  }),
                  retryFingerprint,
                ]
              );
            } else {
              const evalAt = new Date(Date.now() + LOST_EVAL_DELAY_MS).toISOString();
              const evalFingerprint = buildAutomationFingerprint({
                sourceChannel: 'whatsapp',
                targetChannel: 'whatsapp',
                scheduleAt: evalAt,
                text: `${job.lead_id}:lost_eval`,
              });
              await db.query(
                `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
                 VALUES ($1,$2,$3,'whatsapp','whatsapp',$4,$5::jsonb,$6)
                 ON CONFLICT ON CONSTRAINT ux_sales_automation_jobs_pending_fingerprint DO NOTHING`,
                [
                  orgId,
                  req.user.id,
                  job.lead_id,
                  evalAt,
                  JSON.stringify({
                    kind: 'lost_eval',
                    sinceAt: job.created_at,
                    reason: 'retry_sequence_completed',
                    finalAttemptJobId: job.id,
                  }),
                  evalFingerprint,
                ]
              );
            }
            continue;
          } catch (waErr) {
            console.error('[whatsapp] automation send failed', {
              leadId: job.lead_id,
              userId: req.user.id,
              jobId: job.id,
              code: waErr?.code || null,
              providerCode: waErr?.providerCode || null,
              statusCode: waErr?.statusCode || null,
              message: waErr?.message || '',
              traceId: waErr?.providerTraceId || null,
            });
            await db.query(
              `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
               VALUES ($1,$2,'ai_action',$3,'automation_whatsapp_failed',$4::jsonb)`,
              [
                job.lead_id,
                req.user.id,
                whatsappFailureSummary('Automated WhatsApp message failed', waErr),
                JSON.stringify({
                  title: 'Automation WhatsApp Failed',
                  automationJobId: job.id,
                  error: waErr?.message || 'Unknown error',
                  errorCode: waErr?.code || null,
                  providerCode: waErr?.providerCode || null,
                  providerSubcode: waErr?.providerSubcode || null,
                  providerType: waErr?.providerType || null,
                  providerTraceId: waErr?.providerTraceId || null,
                  statusCode: waErr?.statusCode || null,
                }),
              ]
            );
            await db.query(
              `UPDATE sales_automation_jobs
               SET status = 'cancelled', updated_at = NOW()
               WHERE id = $1`,
              [job.id]
            );
            continue;
          }
        }
      }

      const targetText = job.target_channel === 'call' ? 'Bot call is ready to initiate' : 'Bot chat message is ready to send';
      const notifTitle = job.target_channel === 'call' ? 'Scheduled bot call due' : 'Scheduled AI chat due';
      const notifMessage = `${targetText} for ${leadName}. Open Sales workspace to continue.`;
      await db.query(
        `INSERT INTO notifications (user_id, org_id, type, title, message, body, read, metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$5,false,$6::jsonb,NOW())`,
        [
          req.user.id,
          orgId,
          'sales_automation',
          notifTitle,
          notifMessage,
          JSON.stringify({
            link: `/sales/leads/${job.lead_id}`,
            priority: 'critical',
            delivery_status: 'delivered',
            automationJobId: job.id,
            targetChannel: job.target_channel,
            sourceChannel: job.source_channel,
          }),
        ]
      );
      await db.query(
        `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          job.lead_id,
          req.user.id,
          job.target_channel === 'call' ? 'call' : 'whatsapp',
          job.target_channel === 'call'
            ? 'Scheduled call window reached. User notified to initiate bot call.'
            : (job.payload?.messageTemplate || 'Scheduled WhatsApp AI follow-up is ready.'),
          'automation_dispatch_due',
          JSON.stringify({
            title: 'Automation Dispatch',
            automationJobId: job.id,
            sourceChannel: job.source_channel,
            targetChannel: job.target_channel,
            sender: job.target_channel === 'whatsapp' ? 'AI' : undefined,
          }),
        ]
      );
      const { rows: updated } = await db.query(
        `UPDATE sales_automation_jobs
         SET status = 'dispatched', dispatched_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [job.id]
      );
      dispatchedJobs.push(updated[0]);
    }
    res.json({ dispatched: dispatchedJobs.length, jobs: dispatchedJobs });
  } catch (err) {
    next(err);
  }
}

async function dispatchOwnerDailyReports(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    if (!whatsappService.isWhatsAppEnabled()) {
      return res.status(503).json({ error: { code: 'WHATSAPP_NOT_CONFIGURED', message: 'WhatsApp not configured' } });
    }
    const ownerPhone = String(env.ownerWhatsappMsisdn || '').trim();
    if (!ownerPhone) {
      return res.status(400).json({ error: { code: 'OWNER_WHATSAPP_NOT_CONFIGURED', message: 'OWNER_WHATSAPP_MSISDN missing' } });
    }
    const mode = String(req.body?.mode || 'evening').toLowerCase() === 'morning' ? 'morning' : 'evening';
    const pref = await getOwnerReportSettings(req.user.id);
    const enabled = mode === 'morning' ? pref.morningEnabled : pref.eveningEnabled;
    if (!enabled) return res.json({ ok: true, skipped: true, reason: `${mode}_disabled` });
    const tz = String(req.body?.timezone || pref.timezone || env.leadScheduleDefaultTz || 'Asia/Kolkata');

    const [{ rows: leadStats }, { rows: activityStats }, { rows: hotRows }] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)::int AS total,
           SUM(CASE WHEN COALESCE(metadata->>'aiScoreLabel','') = 'Hot' THEN 1 ELSE 0 END)::int AS hot,
           SUM(CASE WHEN COALESCE(metadata->>'aiScoreLabel','') = 'Warm' THEN 1 ELSE 0 END)::int AS warm,
           SUM(CASE WHEN COALESCE(metadata->>'aiScoreLabel','') = 'Cold' THEN 1 ELSE 0 END)::int AS cold,
           SUM(CASE WHEN stage = 'closed_lost' THEN 1 ELSE 0 END)::int AS lost
         FROM leads
         WHERE org_id = $1`,
        [orgId]
      ),
      db.query(
        `SELECT
           SUM(CASE WHEN type = 'call' THEN 1 ELSE 0 END)::int AS calls,
           SUM(CASE WHEN type = 'whatsapp' THEN 1 ELSE 0 END)::int AS whatsapp,
           SUM(CASE WHEN type = 'whatsapp' AND COALESCE(metadata->>'sender','') = 'Lead' THEN 1 ELSE 0 END)::int AS replies
         FROM lead_actions
         WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE $2) AT TIME ZONE $2
           AND lead_id IN (SELECT id FROM leads WHERE org_id = $1)`,
        [orgId, tz]
      ),
      db.query(
        `SELECT contact_first_name, contact_last_name
         FROM leads
         WHERE org_id = $1
           AND COALESCE(metadata->>'aiScoreLabel','') = 'Hot'
         ORDER BY updated_at DESC
         LIMIT 3`,
        [orgId]
      ),
    ]);

    const ls = leadStats[0] || {};
    const as = activityStats[0] || {};
    const hotList = hotRows
      .map((r) => `${String(r.contact_first_name || '').trim()} ${String(r.contact_last_name || '').trim()}`.trim())
      .filter(Boolean);

    const header = mode === 'morning' ? 'Today Plan' : 'Today Summary';
    const msg = [
      `${header}:`,
      ``,
      `Leads: ${ls.total || 0} (Hot ${ls.hot || 0}, Warm ${ls.warm || 0}, Cold ${ls.cold || 0}, Lost ${ls.lost || 0})`,
      ``,
      `Activity:`,
      `Calls: ${as.calls || 0}`,
      `WhatsApp: ${as.whatsapp || 0} chats`,
      `Replies: ${as.replies || 0}`,
      ``,
      hotList.length ? `Hot Leads: ${hotList.map((x) => `- ${x}`).join('\n')}` : 'Hot Leads: none',
      ``,
      mode === 'morning'
        ? 'Focus: Follow hot leads first.'
        : 'Summary: Keep momentum on hot/warm follow-ups.',
    ].join('\n');

    const sent = await whatsappService.sendWhatsAppText({ to: ownerPhone, text: msg.slice(0, 3800) });
    return res.json({ ok: true, mode, timezone: tz, messageId: sent.messageId || null });
  } catch (err) {
    next(err);
  }
}

async function getOwnerReportSettingsHandler(req, res, next) {
  try {
    const settings = await getOwnerReportSettings(req.user.id);
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}

async function updateOwnerReportSettingsHandler(req, res, next) {
  try {
    const morningEnabled = req.body?.morningEnabled;
    const eveningEnabled = req.body?.eveningEnabled;
    const timezone = req.body?.timezone;
    const nextPatch = {};
    if (morningEnabled !== undefined) nextPatch.morningEnabled = Boolean(morningEnabled);
    if (eveningEnabled !== undefined) nextPatch.eveningEnabled = Boolean(eveningEnabled);
    if (timezone !== undefined) nextPatch.timezone = String(timezone || '').trim() || 'Asia/Kolkata';

    const { rows } = await db.query(
      `UPDATE users
       SET metadata = COALESCE(metadata, '{}'::jsonb)
         || jsonb_build_object(
            'settings',
            COALESCE(metadata->'settings', '{}'::jsonb)
            || jsonb_build_object(
                'ownerWhatsAppReports',
                COALESCE(metadata->'settings'->'ownerWhatsAppReports', '{}'::jsonb) || $1::jsonb
              )
          ),
          updated_at = NOW()
       WHERE id = $2
       RETURNING id`,
      [JSON.stringify(nextPatch), req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    const settings = await getOwnerReportSettings(req.user.id);
    return res.json(settings);
  } catch (err) {
    next(err);
  }
}

async function setWhatsAppTakeover(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const leadId = req.params.id;
    const mode = String(req.body?.mode || 'human').toLowerCase() === 'ai' ? 'ai' : 'human';
    const expiresInMins = Math.max(1, Math.min(120, Number(req.body?.expiresInMins || 30)));
    const patch =
      mode === 'human'
        ? {
            whatsappHumanTakeoverMode: 'human',
            whatsappHumanTakeoverBy: req.user.id,
            whatsappHumanTakeoverUntil: new Date(Date.now() + expiresInMins * 60 * 1000).toISOString(),
          }
        : {
            whatsappHumanTakeoverMode: 'ai',
            whatsappHumanTakeoverBy: null,
            whatsappHumanTakeoverUntil: null,
          };
    const { rows } = await db.query(
      `UPDATE leads
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
           updated_at = NOW()
       WHERE id = $1 AND org_id = $2
       RETURNING id, metadata`,
      [leadId, orgId, JSON.stringify(patch)]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    return res.json({
      leadId,
      mode,
      takeoverUntil: rows[0].metadata?.whatsappHumanTakeoverUntil || null,
    });
  } catch (err) {
    next(err);
  }
}

async function listLeadAutomationJobs(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);
    const leadId = req.params.id;
    const status = req.query.status ? String(req.query.status) : null;
    const params = [orgId, req.user.id, leadId];
    let sql = `SELECT * FROM sales_automation_jobs WHERE org_id = $1 AND user_id = $2 AND lead_id = $3`;
    if (status) {
      params.push(status);
      sql += ` AND status = $4`;
    }
    sql += ` ORDER BY schedule_at DESC LIMIT 100`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function updateAutomationJobStatus(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const jobId = req.params.jobId;
    const status = String(req.body?.status || '').toLowerCase();
    const { rows } = await db.query(
      `UPDATE sales_automation_jobs
       SET status = $1, updated_at = NOW()
       WHERE id = $2
         AND org_id = $3
         AND user_id = $4
         AND status IN ('pending', 'dispatched')
       RETURNING *`,
      [status, jobId, orgId, req.user.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Automation job not found or already closed' } });
    }
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function cleanupLeadAutomationJobs(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const leadId = req.params.id;
    const targetChannel = String(req.body?.targetChannel || 'call').toLowerCase();
    const { rows } = await db.query(
      `UPDATE sales_automation_jobs
       SET status = 'cancelled', updated_at = NOW()
       WHERE org_id = $1
         AND user_id = $2
         AND lead_id = $3
         AND target_channel = $4
         AND status IN ('pending', 'dispatched')
       RETURNING id`,
      [orgId, req.user.id, leadId, targetChannel]
    );
    return res.json({ cancelled: rows.length });
  } catch (err) {
    next(err);
  }
}

async function saveCampaignWebsite(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { websiteUrl } = req.body;

    const { rows } = await db.query(
      `UPDATE campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [JSON.stringify({ website_url: websiteUrl }), req.params.campaignId, orgId]
    );

    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function listCampaignGoalSamples(req, res, next) {
  try {
    return res.json({
      samples: [
        { id: 'lead_qualification', label: 'Lead qualification call', type: 'outbound' },
        { id: 'site_visit_booking', label: 'Book site visits', type: 'outbound' },
        { id: 'demo_booking', label: 'Book demo calls', type: 'outbound' },
        { id: 'renewal_followup', label: 'Renewal follow-up', type: 'outbound' },
        { id: 'inbound_screening', label: 'Inbound screening and routing', type: 'inbound' },
      ],
    });
  } catch (err) {
    next(err);
  }
}

function parseTimeWindowValue(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}`;
}

function digitsOnlyPhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

/** Minimum digits so Tata normalizeDialNumber can build a destination (e.g. 91 + 10). */
function hasDialableLeadPhone(phone) {
  const d = digitsOnlyPhone(phone);
  return d.length >= 10;
}

/**
 * Resolve or create a `leads` row for a campaign_lead so sales_automation_jobs (FK → leads) can dial them.
 */
async function ensureSalesLeadForCampaignLead({
  orgId,
  userId,
  campaignId,
  campaignName,
  projectId,
  campaignLead,
}) {
  const raw = digitsOnlyPhone(campaignLead.phone);
  if (!raw || raw.length < 7) return null;
  const tail10 = raw.slice(-10);
  const fullName = String(campaignLead.name || 'Campaign lead').trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || 'Lead';
  const lastName = parts.slice(1).join(' ') || '';

  let leadId;

  if (campaignLead.deal_id) {
    const { rows } = await db.query(`SELECT id FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`, [
      campaignLead.deal_id,
      orgId,
    ]);
    if (rows[0]) leadId = rows[0].id;
  }

  if (!leadId) {
    const { rows: existing } = await db.query(
      `SELECT id FROM leads
       WHERE org_id = $1
         AND RIGHT(regexp_replace(COALESCE(contact_phone, ''), '\\D', '', 'g'), 10) = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [orgId, tail10]
    );
    if (existing[0]) {
      leadId = existing[0].id;
      await db.query(`UPDATE campaign_leads SET deal_id = $1, updated_at = NOW() WHERE id = $2`, [
        leadId,
        campaignLead.id,
      ]);
    }
  }

  if (!leadId) {
    const meta = {
      campaignId,
      campaignName: campaignName || null,
      projectId: projectId || null,
      preferredLocale: 'hing',
      source: 'campaign_upload',
    };
    const { rows: inserted } = await db.query(
      `INSERT INTO leads
         (org_id, user_id, contact_first_name, contact_last_name, contact_email, contact_phone,
          company_name, stage, priority, value, source, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'new','medium',0,$8,$9::jsonb)
       RETURNING id`,
      [
        orgId,
        userId,
        firstName,
        lastName || null,
        campaignLead.email || null,
        raw,
        null,
        `Campaign: ${(campaignName || '').slice(0, 80)}`,
        JSON.stringify(meta),
      ]
    );
    leadId = inserted[0].id;
    await db.query(`UPDATE campaign_leads SET deal_id = $1, updated_at = NOW() WHERE id = $2`, [leadId, campaignLead.id]);
    return leadId;
  }

  // deal_id or phone-dedupe match: always sync dial digits from the campaign row so automation
  // uses the same number as the list (CRM rows may have empty or stale contact_phone).
  await db.query(
    `UPDATE leads
       SET contact_phone = $2,
           contact_first_name = COALESCE(NULLIF(TRIM($3::text), ''), contact_first_name),
           contact_last_name = COALESCE(NULLIF(TRIM($4::text), ''), contact_last_name),
           updated_at = NOW()
     WHERE id = $1 AND org_id = $5`,
    [leadId, raw, firstName, lastName || null, orgId]
  );
  return leadId;
}

/**
 * Queue staggered outbound bot calls for every campaign lead with a phone.
 * The background dispatcher (server.js) picks up sales_automation_jobs and calls createVoiceSession one-by-one.
 */
async function enqueueCampaignCallQueue(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    }
    if (!tataVoiceService.isTelephonyEnabled()) {
      return res.status(400).json({
        error: {
          code: 'TELEPHONY_DISABLED',
          message: 'Tata Smartflo telephony is not configured. Set Tata env vars and enable outbound in settings.',
        },
      });
    }

    const campaignId = req.params.campaignId;
    const rawRp = req.body?.replacePending ?? req.body?.replace_pending;
    let replacePending = true;
    if (rawRp === false || rawRp === 0) replacePending = false;
    else if (typeof rawRp === 'string' && ['false', '0', 'no'].includes(rawRp.trim().toLowerCase())) {
      replacePending = false;
    }

    const { rows: campRows } = await db.query(
      `SELECT id, name, project_id, metadata FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [campaignId, orgId]
    );
    const campaign = campRows[0];
    if (!campaign) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    let md = {};
    const rawMd = campaign.metadata;
    if (rawMd && typeof rawMd === 'object' && !Array.isArray(rawMd)) {
      md = rawMd;
    } else if (typeof rawMd === 'string') {
      try {
        const p = JSON.parse(rawMd);
        if (p && typeof p === 'object' && !Array.isArray(p)) md = p;
      } catch (_) {
        md = {};
      }
    }
    const gapFromBody = req.body?.gapSeconds ?? req.body?.gap_seconds;
    const gapParsed = parseInt(String(gapFromBody ?? ''), 10);
    const gapFromMd = parseInt(String(md.outbound_call_gap_seconds ?? ''), 10);
    const gapSeconds = Math.max(
      45,
      Math.min(
        900,
        (Number.isFinite(gapParsed) && gapParsed > 0 ? gapParsed : null) ||
          (Number.isFinite(gapFromMd) && gapFromMd > 0 ? gapFromMd : null) ||
          120
      )
    );

    if (!md.calling_enabled) {
      return res.status(400).json({
        error: {
          code: 'CALLING_NOT_ENABLED',
          message: 'Enable AI calling and save communication setup before queueing calls.',
        },
      });
    }
    const script = String(md.calling_script || '').trim();
    if (!script) {
      return res.status(400).json({
        error: {
          code: 'CALLING_SCRIPT_REQUIRED',
          message: 'Add a calling script (or generate one) before queueing outbound calls.',
        },
      });
    }

    const projectId = campaign.project_id || md.project_id || null;
    const agentName =
      String(md.agent_custom_name || md.agent_male_name || md.agent_female_name || '').trim() || 'SalesPal AI';

    if (replacePending) {
      await db.query(
        `UPDATE sales_automation_jobs
         SET status = 'cancelled', updated_at = NOW()
         WHERE org_id = $1
           AND user_id = $2
           AND status = 'pending'
           AND payload->>'kind' = 'campaign_outbound'
           AND payload->>'campaignId' = $3`,
        [orgId, req.user.id, campaignId]
      );
    }

    const { rows: cLeads } = await db.query(
      `SELECT id, name, phone, email, deal_id, created_at
       FROM campaign_leads
       WHERE campaign_id = $1 AND org_id = $2
       ORDER BY created_at ASC`,
      [campaignId, orgId]
    );

    const callWindow = await getUserSalesCallWindow(req.user.id);
    let queued = 0;
    let skippedNoPhone = 0;
    let skippedInvalid = 0;
    let skippedDup = 0;
    const errors = [];

    let slotCursor = Date.now();

    for (let i = 0; i < cLeads.length; i += 1) {
      const cl = cLeads[i];
      const rawPhone = digitsOnlyPhone(cl.phone);
      if (!cl.phone || !rawPhone) {
        skippedNoPhone += 1;
        continue;
      }
      if (!isValidPhone(cl.phone)) {
        skippedInvalid += 1;
        continue;
      }

      let leadId;
      try {
        leadId = await ensureSalesLeadForCampaignLead({
          orgId,
          userId: req.user.id,
          campaignId,
          campaignName: campaign.name,
          projectId,
          campaignLead: cl,
        });
      } catch (e) {
        errors.push({ campaignLeadId: cl.id, error: e.message || 'lead_create_failed' });
        continue;
      }
      if (!leadId) {
        skippedInvalid += 1;
        continue;
      }

      await db.query(
        `UPDATE leads
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          leadId,
          JSON.stringify({
            projectId: projectId || null,
            agentName,
            campaign: String(campaign.name || '').trim() || null,
          }),
        ]
      );

      let scheduleAt = new Date(slotCursor).toISOString();
      const leadTimezone = 'Asia/Kolkata';
      if (!isWithinCallWindow(scheduleAt, leadTimezone, callWindow)) {
        scheduleAt = nextAvailableCallIso(scheduleAt, leadTimezone, callWindow);
        slotCursor = new Date(scheduleAt).getTime();
      }

      const fingerprint = buildAutomationFingerprint({
        sourceChannel: 'call',
        targetChannel: 'call',
        scheduleAt,
        text: `campaign_outbound:${campaignId}:${cl.id}:${i}:${scheduleAt}`,
      });

      const payload = {
        kind: 'campaign_outbound',
        campaignId,
        campaignLeadId: cl.id,
        messageTemplate: script,
      };

      const ins = await db
        .query(
          `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
           VALUES ($1,$2,$3,'call','call',$4,$5::jsonb,$6)
           RETURNING id`,
          [orgId, req.user.id, leadId, scheduleAt, JSON.stringify(payload), fingerprint]
        )
        .catch((err) => {
          if (String(err?.message || '').includes('ux_sales_automation_jobs_pending_fingerprint')) {
            return { rows: [] };
          }
          throw err;
        });

      if (!ins.rows[0]) {
        skippedDup += 1;
      } else {
        queued += 1;
        slotCursor += gapSeconds * 1000;
        await salesEngagement
          .getOrCreateSession({ orgId, leadId, userId: req.user.id })
          .catch(() => null);
        await salesEngagement
          .applyEvent({
            leadId,
            orgId,
            event: salesEngagement.ENGAGEMENT_EVENTS.CAMPAIGN_NUDGE,
            channel: 'voice_pstn',
            metadata: { campaignId, campaignLeadId: cl.id, automationJobId: ins.rows[0].id },
          })
          .catch(() => {});
      }
    }

    return res.json({
      ok: true,
      campaignId,
      gapSeconds,
      totalCampaignLeads: cLeads.length,
      queued,
      skippedNoPhone,
      skippedInvalid,
      skippedDup,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    next(err);
  }
}

/** Cancel pending staggered outbound jobs for this campaign (e.g. when campaign is paused). */
async function cancelCampaignCallQueue(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    }
    const campaignId = req.params.campaignId;
    const { rows: campRows } = await db.query(`SELECT id FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`, [
      campaignId,
      orgId,
    ]);
    if (!campRows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }
    const result = await db.query(
      `UPDATE sales_automation_jobs
       SET status = 'cancelled', updated_at = NOW()
       WHERE org_id = $1
         AND user_id = $2
         AND status = 'pending'
         AND payload->>'kind' = 'campaign_outbound'
         AND payload->>'campaignId' = $3`,
      [orgId, req.user.id, campaignId]
    );
    return res.json({
      ok: true,
      campaignId,
      cancelled: result.rowCount ?? 0,
    });
  } catch (err) {
    next(err);
  }
}

async function saveCampaignCommunicationSetup(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows: campaigns } = await db.query(
      `SELECT id, metadata FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [req.params.campaignId, orgId]
    );
    const campaign = campaigns[0];
    if (!campaign) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    const body = req.body || {};
    const telephonyProvider = String(body.telephonyProvider || body.telephony_provider || 'tata_smartflo').trim().toLowerCase();
    if (!['tata', 'tata_smartflo', 'tata smartflo'].includes(telephonyProvider)) {
      return res.status(400).json({
        error: {
          code: 'TELEPHONY_PROVIDER_NOT_ALLOWED',
          message: 'Only Tata Smartflo is supported for calling campaigns.',
        },
      });
    }

    const campaignType = String(body.campaignType || body.campaign_type || 'outbound').toLowerCase();
    if (!['inbound', 'outbound'].includes(campaignType)) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'campaignType must be inbound or outbound' } });
    }

    const callingScript = String(body.callingScript || body.calling_script || '').trim();
    let complianceStatus = 'not_run';
    if (callingScript) {
      try {
        const compliance = await callComplianceService.scanCallingScript(callingScript);
        complianceStatus = compliance?.blocked ? 'blocked' : 'passed';
        if (compliance?.blocked) {
          return res.status(422).json({
            error: {
              code: 'SCRIPT_COMPLIANCE_BLOCKED',
              message: 'Manual script contains abusive, false, or non-compliant content. Please revise before saving.',
            },
            compliance,
          });
        }
      } catch (_) {
        // Keep campaign setup operational even if scanner is temporarily unavailable.
        complianceStatus = 'scan_unavailable';
      }
    }

    const selectedLanguages = Array.isArray(body.selectedLanguages || body.selected_languages)
      ? (body.selectedLanguages || body.selected_languages).map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
      : [];
    const start = parseTimeWindowValue(body.outboundWindowStart || body.outbound_window_start || '09:00');
    const end = parseTimeWindowValue(body.outboundWindowEnd || body.outbound_window_end || '21:00');
    if (!start || !end) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Outbound window must be HH:MM format' } });
    }

    const rawMd = campaign.metadata;
    let baseMd = {};
    if (rawMd && typeof rawMd === 'object' && !Array.isArray(rawMd)) {
      baseMd = rawMd;
    } else if (typeof rawMd === 'string') {
      try {
        const parsed = JSON.parse(rawMd);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) baseMd = parsed;
      } catch (_) {
        baseMd = {};
      }
    }
    const nextMd = {
      ...baseMd,
      calling_enabled: Boolean(body.callingEnabled ?? body.calling_enabled),
      calling_goal: String(body.callingGoal ?? body.calling_goal ?? ''),
      calling_goal_sample: String(body.callingGoalSample ?? body.calling_goal_sample ?? ''),
      calling_audience: String(body.callingAudience ?? body.calling_audience ?? ''),
      calling_script: callingScript,
      whatsapp_enabled: Boolean(body.waEnabled ?? body.whatsapp_enabled),
      whatsapp_goal: String(body.waGoal ?? body.whatsapp_goal ?? ''),
      whatsapp_offer: String(body.waOffer ?? body.whatsapp_offer ?? ''),
      whatsapp_message: String(body.waMessage ?? body.whatsapp_message ?? ''),
      campaign_type: campaignType,
      telephony_provider: 'tata_smartflo',
      brain_drive_connected: Boolean(body.brainDriveConnected ?? body.brain_drive_connected),
      brain_drive_collection: String(body.brainDriveCollection ?? body.brain_drive_collection ?? ''),
      business_number: String(body.businessNumber ?? body.business_number ?? ''),
      whatsapp_report_number: String(body.whatsappReportNumber ?? body.whatsapp_report_number ?? ''),
      language_country: String(body.languageCountry ?? body.language_country ?? 'india'),
      selected_languages: selectedLanguages,
      agent_male_name: String(body.agentMaleName ?? body.agent_male_name ?? 'Rahul'),
      agent_female_name: String(body.agentFemaleName ?? body.agent_female_name ?? 'Priya'),
      agent_custom_name: String(body.agentCustomName ?? body.agent_custom_name ?? ''),
      outbound_window_start: start,
      outbound_window_end: end,
      logo_enabled: Boolean(body.logoEnabled ?? body.logo_enabled),
      logo_url: String(body.logoUrl ?? body.logo_url ?? ''),
      user_media_enabled: Boolean(body.userMediaEnabled ?? body.user_media_enabled),
      user_media_urls: Array.isArray(body.userMediaUrls ?? body.user_media_urls)
        ? (body.userMediaUrls ?? body.user_media_urls).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20)
        : [],
      pre_script_required: true,
      script_compliance_status: complianceStatus,
      communication_setup_updated_at: new Date().toISOString(),
      outbound_call_gap_seconds: Math.max(
        45,
        Math.min(
          900,
          parseInt(String(body.outboundCallGapSeconds ?? body.outbound_call_gap_seconds ?? '120'), 10) || 120
        )
      ),
    };

    const { rows: updatedRows } = await db.query(
      `UPDATE campaigns
       SET metadata = $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [JSON.stringify(nextMd), req.params.campaignId, orgId]
    );
    return res.json(updatedRows[0]);
  } catch (err) {
    next(err);
  }
}

async function getLeadEngagement(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const leadId = req.params.id;
    const { rows: leadRows } = await db.query(`SELECT id FROM leads WHERE id = $1 AND org_id = $2`, [leadId, orgId]);
    if (!leadRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    const session = await salesEngagement.getOrCreateSession({ orgId, leadId, userId: req.user.id });
    return res.json({ session });
  } catch (err) {
    next(err);
  }
}

async function listLeadEngagementEvents(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });
    const leadId = req.params.id;
    const { rows: leadRows } = await db.query(`SELECT id FROM leads WHERE id = $1 AND org_id = $2`, [leadId, orgId]);
    if (!leadRows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } });
    const lim = parseInt(String(req.query.limit || '50'), 10);
    const events = await salesEngagement.listEngagementEvents(leadId, lim);
    return res.json({ events });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDeals,
  getDeal,
  createDeal,
  updateDeal,
  deleteDeal,
  listActivities,
  createLeadAction,
  listLeadActions,
  createSalesCampaign,
  saveCampaignWebsite,
  saveCampaignCommunicationSetup,
  enqueueCampaignCallQueue,
  cancelCampaignCallQueue,
  listCampaignGoalSamples,
  listCampaignLeads,
  addCampaignLead,
  deleteCampaignLead,
  createAutomationJob,
  dispatchDueAutomationJobs,
  dispatchOwnerDailyReports,
  getOwnerReportSettingsHandler,
  updateOwnerReportSettingsHandler,
  listLeadAutomationJobs,
  updateAutomationJobStatus,
  cleanupLeadAutomationJobs,
  setWhatsAppTakeover,
  getLeadEngagement,
  listLeadEngagementEvents,
};