const db = require('../config/db');
const crypto = require('crypto');
const aiRuntime = require('../services/aiRuntime.service');
const aiService = require('../services/ai.service');
const whatsappService = require('../services/whatsapp.service');

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
    res.status(201).json(rows[0]);
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
    if (!orgId) return res.json([]);

    const { rows } = await db.query(
      `SELECT * FROM campaign_leads WHERE org_id = $1 AND campaign_id = $2 ORDER BY created_at DESC`,
      [orgId, req.params.campaignId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function addCampaignLead(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

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

const CALL_WINDOW_START_HOUR = 9;
const CALL_WINDOW_END_HOUR = 21; // exclusive

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

function isWithinCallWindow(scheduleAt, timeZone = 'Asia/Kolkata') {
  const z = getZonedParts(scheduleAt, timeZone);
  const hh = Number(z.hour || 0);
  return hh >= CALL_WINDOW_START_HOUR && hh < CALL_WINDOW_END_HOUR;
}

function nextAvailableCallIso(scheduleAt, timeZone = 'Asia/Kolkata') {
  const z = getZonedParts(scheduleAt, timeZone);
  const y = Number(z.year);
  const m = Number(z.month);
  const d = Number(z.day);
  const hh = Number(z.hour || 0);
  if (hh < CALL_WINDOW_START_HOUR) {
    return zonedDateToUtcIso(y, m, d, CALL_WINDOW_START_HOUR, 0, timeZone);
  }
  return zonedDateToUtcIso(y, m, d + 1, CALL_WINDOW_START_HOUR, 0, timeZone);
}

function parseNaturalScheduleAt(text, timeZone = 'Asia/Kolkata') {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const now = new Date();

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
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'ai_action',$3,'whatsapp_send_failed',$4::jsonb)`,
            [
              leadId,
              req.user.id,
              'WhatsApp send failed. Verify WhatsApp Cloud API credentials and destination number format.',
              JSON.stringify({
                title: 'WhatsApp Send Failed',
                error: sendErr?.message || 'Unknown error',
                errorCode: sendErr?.code || null,
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
      const handshake = inferHandshakeIntent({ type, content, metadata: meta, leadTimezone });
      if (handshake) {
        if (handshake.targetChannel === 'call' && !isWithinCallWindow(handshake.scheduleAt, leadTimezone)) {
          const suggestedIso = nextAvailableCallIso(handshake.scheduleAt, leadTimezone);
          const requestedAt = new Date(handshake.scheduleAt).toLocaleString('en-US', { timeZone: leadTimezone });
          const suggestedAt = new Date(suggestedIso).toLocaleString('en-US', { timeZone: leadTimezone });
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'whatsapp',$3,'automation_outside_call_window',$4::jsonb)`,
            [
              leadId,
              req.user.id,
              `Requested call time ${requestedAt} is outside call hours (9:00 AM - 9:00 PM). Next available slot: ${suggestedAt}.`,
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
      `SELECT * FROM lead_actions WHERE lead_id = $1 ORDER BY created_at ASC LIMIT $2`,
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
    if (targetChannel === 'call' && !isWithinCallWindow(scheduleDate.toISOString(), leadTimezone)) {
      const suggestedIso = nextAvailableCallIso(scheduleDate.toISOString(), leadTimezone);
      return res.status(400).json({
        error: {
          code: 'CALL_WINDOW_UNAVAILABLE',
          message: `Call slots are available 9:00 AM - 9:00 PM (${leadTimezone}). Suggested: ${new Date(suggestedIso).toLocaleString('en-US', { timeZone: leadTimezone })}`,
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
      if (job.target_channel === 'call') {
        try {
          const leadMetadata = job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
          const locale = leadMetadata.preferredLocale || 'hing';
          const projectId = leadMetadata.projectId || null;
          const agentName = leadMetadata.agentName || 'SalesPal AI';
          const tpl = (job.payload && typeof job.payload === 'object' && String(job.payload.messageTemplate || '').trim()) || '';
          const cont = (job.payload && typeof job.payload === 'object' && String(job.payload.voiceContinuationSnippet || '').trim()) || '';
          const openerContext = [tpl, cont ? `Callback context (prior voice session):\n${cont}` : '']
            .filter(Boolean)
            .join('\n\n');

          const { session, telephony } = await aiRuntime.createVoiceSession({
            brandId: `web-${req.user.id}`,
            leadId: job.lead_id,
            phone: job.contact_phone,
            name: leadName,
            locale,
            mode: 'automation',
            openerContext,
            projectId,
            agentName,
            orgId,
            userId: req.user.id,
          });

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
        const requestedTemplate =
          (job.payload && typeof job.payload === 'object' && String(job.payload.messageTemplate || '').trim()) || '';
        let outboundText = requestedTemplate;
        if (!outboundText) {
          try {
            const leadLocale = (job.metadata && typeof job.metadata === 'object' && job.metadata.preferredLocale) || 'hing';
            outboundText = await aiService.callAIWithMessages(
              [
                {
                  role: 'user',
                  content: `Write one concise WhatsApp follow-up message for ${leadName}. Keep it natural and ask one clear next-step question.`,
                },
              ],
              aiService.systemPromptForChat('whatsapp', { leadPreferredLocale: leadLocale }),
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
            continue;
          } catch (waErr) {
            await db.query(
              `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
               VALUES ($1,$2,'ai_action',$3,'automation_whatsapp_failed',$4::jsonb)`,
              [
                job.lead_id,
                req.user.id,
                'Automated WhatsApp message failed to send. Please verify WhatsApp Cloud API credentials.',
                JSON.stringify({
                  title: 'Automation WhatsApp Failed',
                  automationJobId: job.id,
                  error: waErr?.message || 'Unknown error',
                  errorCode: waErr?.code || null,
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
  listCampaignLeads,
  addCampaignLead,
  createAutomationJob,
  dispatchDueAutomationJobs,
  listLeadAutomationJobs,
  updateAutomationJobStatus,
  cleanupLeadAutomationJobs,
};
