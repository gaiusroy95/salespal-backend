const db = require('../config/db');
const crypto = require('crypto');
const env = require('../config/env');
const logger = require('../config/logger');
const whatsappService = require('../services/whatsapp.service');
const aiService = require('../services/ai.service');
const { retrieveTopK } = require('../services/projectKnowledge.service');
const { honorificNameJi } = require('../utils/voiceHonorifics');

function headerValue(req, name) {
  if (!name) return '';
  return String(req.headers[String(name).toLowerCase()] || '');
}

function getProviderCallId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(
    payload.uuid ||
      payload.call_id ||
      payload.callId ||
      payload.request_id ||
      payload.requestId ||
      payload.id ||
      ''
  ).trim();
}

function getCallStatus(payload) {
  const status = String(
    payload.call_status ||
      payload.status ||
      payload.event ||
      payload.disposition ||
      payload.hangup_cause ||
      'unknown'
  )
    .trim()
    .toLowerCase();
  return status || 'unknown';
}

function normalizeDigits(v) {
  return String(v || '').replace(/[^\d]/g, '');
}

function extractInboundText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const text = String(msg?.text?.body || '').trim();
  if (text) return text;
  const buttonText = String(msg?.button?.text || '').trim();
  if (buttonText) return buttonText;
  const interactiveTitle = String(msg?.interactive?.button_reply?.title || '').trim();
  if (interactiveTitle) return interactiveTitle;
  const interactiveListTitle = String(msg?.interactive?.list_reply?.title || '').trim();
  if (interactiveListTitle) return interactiveListTitle;
  const interactiveListId = String(msg?.interactive?.list_reply?.id || '').trim();
  if (interactiveListId) return interactiveListId;
  return '';
}

function isStopIntent(text) {
  const t = String(text || '').toLowerCase();
  return /\b(stop|unsubscribe|opt[\s-]?out|do not message|don't message|block)\b/.test(t);
}

function asksForHuman(text) {
  const t = String(text || '').toLowerCase();
  return /\b(human|agent|representative|manager|owner|person)\b/.test(t);
}

async function findLeadByPhone(phoneDigits) {
  if (!phoneDigits) return null;
  const last10 = phoneDigits.slice(-10);
  const { rows } = await db.query(
    `SELECT id, org_id, user_id, assigned_to, contact_first_name, contact_last_name, contact_phone, metadata
     FROM leads
     WHERE regexp_replace(COALESCE(contact_phone, ''), '\D', '', 'g') = $1
        OR RIGHT(regexp_replace(COALESCE(contact_phone, ''), '\D', '', 'g'), 10) = $2
     ORDER BY updated_at DESC
     LIMIT 1`,
    [phoneDigits, last10]
  );
  return rows[0] || null;
}

async function buildWhatsAppHistory(leadId) {
  const { rows } = await db.query(
    `SELECT content, metadata
     FROM lead_actions
     WHERE lead_id = $1
       AND type = 'whatsapp'
     ORDER BY created_at DESC
     LIMIT 20`,
    [leadId]
  );
  return rows
    .reverse()
    .map((r) => {
      const md = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
      const sender = String(md.sender || '').toLowerCase() === 'lead' ? 'user' : 'assistant';
      return { role: sender, content: String(r.content || '').trim() };
    })
    .filter((x) => x.content);
}

function shouldStayIn24hWindow(text) {
  const t = String(text || '').toLowerCase();
  return /(kal|tomorrow).*(baat|talk|follow|ping|message)/i.test(t);
}

function inferImmediateOrTimedCall(text) {
  const t = String(text || '').toLowerCase();
  if (!/\b(call|phone|ring|voice call|callback)\b/i.test(t)) return null;
  const now = new Date();
  if (/\b(now|right now|immediately|immediate|asap|as soon as possible)\b/i.test(t)) {
    return new Date(now.getTime() + 20 * 1000).toISOString();
  }
  const inMins = t.match(/\b(?:in|after)\s+(\d{1,3})\s*(minute|minutes|min|mins)\b/i);
  if (inMins) {
    const n = Number(inMins[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 60 * 1000).toISOString();
  }
  const inHours = t.match(/\b(?:in|after)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/i);
  if (inHours) {
    const n = Number(inHours[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 60 * 60 * 1000).toISOString();
  }
  return null;
}

function buildSimpleAutomationFingerprint(seed) {
  return crypto.createHash('sha256').update(String(seed || '')).digest('hex');
}

async function buildLeadProjectKnowledgePrompt({ orgId, leadMetadata, queryText }) {
  const md = leadMetadata && typeof leadMetadata === 'object' ? leadMetadata : {};
  const projectId = String(md.projectId || md.project_id || '').trim();
  if (!projectId) return '';

  const { rows: projectRows } = await db.query(
    `SELECT id, name, description FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [projectId, orgId]
  );
  const project = projectRows[0];
  if (!project) return '';

  const { rows: knowledgeRows } = await db.query(
    `SELECT source_type, source_name, content, embedding
     FROM project_knowledge
     WHERE org_id = $1 AND project_id = $2`,
    [orgId, projectId]
  );
  const q = String(queryText || '').trim() || `${project.name || 'project'} overview pricing location`;
  const top = retrieveTopK(q, knowledgeRows, 8);
  const evidence = top
    .map((r) => `[${String(r.source_type || 'source')}] ${String(r.content || '').trim()}`)
    .filter(Boolean)
    .slice(0, 8);

  return [
    'PROJECT KNOWLEDGE MODE (STRICT):',
    `- Selected project: "${String(project.name || '').trim() || project.id}"`,
    String(project.description || '').trim()
      ? `- Project description:\n${String(project.description || '').trim().slice(0, 900)}`
      : null,
    evidence.length
      ? `- Brain Drive evidence excerpts (ground truth):\n${evidence.join('\n---\n')}`
      : '- Brain Drive evidence excerpts: none indexed yet.',
    '- Discuss this selected project only. Avoid generic SalesPal marketing replies unless explicitly asked about the software.',
    '- If requested detail is missing in evidence, say it is not in indexed materials and offer human follow-up.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function upsertLeadMetadata(leadId, patch) {
  await db.query(
    `UPDATE leads
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [leadId, JSON.stringify(patch || {})]
  );
}

async function getUserHumanPersona(userId) {
  if (!userId) return 'friendly_consultant';
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

async function tataCallStatus(req, res) {
  try {
    const token = String(env.telephony?.webhookToken || '').trim();
    if (token) {
      const tokenHeader = String(env.telephony?.webhookTokenHeader || 'x-tata-webhook-token');
      const provided = headerValue(req, tokenHeader);
      if (!provided || provided !== token) {
        return res.status(401).json({ ok: false, message: 'Invalid webhook token' });
      }
    }

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const providerCallId = getProviderCallId(payload);
    const callStatus = getCallStatus(payload);
    const outcome = `tata_${callStatus}`.slice(0, 80);

    const rawEventId = String(payload.event_id || payload.uuid || payload.id || '');
    const eventId = rawEventId || `${providerCallId || 'no-call-id'}:${callStatus}:${Date.now()}`;

    await db.query(
      `CREATE TABLE IF NOT EXISTS telephony_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        event_id TEXT UNIQUE NOT NULL,
        call_id TEXT,
        status TEXT,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    const inserted = await db.query(
      `INSERT INTO telephony_webhook_events (provider, event_id, call_id, status, payload)
       VALUES ('tata', $1, $2, $3, $4::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING id`,
      [eventId, providerCallId || null, callStatus, JSON.stringify(payload)]
    );
    if (!inserted.rows[0]) {
      return res.json({ ok: true, deduped: true });
    }

    if (providerCallId) {
      const ref = await db.query(
        `SELECT lead_id, user_id, metadata
         FROM lead_actions
         WHERE metadata->'telephony'->>'providerCallId' = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [providerCallId]
      );

      const row = ref.rows[0];
      if (row?.lead_id && row?.user_id) {
        await db.query(
          `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
           VALUES ($1,$2,'call',$3,$4,$5::jsonb)`,
          [
            row.lead_id,
            row.user_id,
            `Tata call status update: ${callStatus}`,
            outcome,
            JSON.stringify({
              title: 'Tata Call Status',
              provider: 'tata',
              providerCallId,
              status: callStatus,
              eventPayload: payload,
            }),
          ]
        );

        const badConnect = ['no_answer', 'no-answer', 'busy', 'user_busy', 'failed', 'cancel', 'cancelled', 'cancelled.', 'reject', 'rejected', 'congestion', 'unreachable', 'network_unreachable', 'no_route'];
        const st = callStatus.replace(/\./g, '').toLowerCase();
        const shouldRecover = badConnect.some((x) => st.includes(x.replace(/\./g, '')));
        if (shouldRecover && whatsappService.isWhatsAppEnabled()) {
          const dedupe = await db.query(
            `SELECT 1 FROM lead_actions
             WHERE lead_id = $1
               AND outcome = 'whatsapp_tata_recovery_ping'
               AND metadata->>'tataRecoverForCallId' = $2
             LIMIT 1`,
            [row.lead_id, providerCallId]
          );
          if (!dedupe.rows[0]) {
            try {
              const lead = await db.query(
                `SELECT contact_phone, contact_first_name, contact_last_name FROM leads WHERE id = $1 LIMIT 1`,
                [row.lead_id]
              );
              const l = lead.rows[0];
              const phone = l?.contact_phone;
              if (phone) {
                const name = `${l.contact_first_name || ''} ${l.contact_last_name || ''}`.trim();
                const ji = honorificNameJi(name || 'Ji');
                const brand = env.whatsapp?.voiceBrandName || 'SalesPal';
                await whatsappService.sendWhatsAppText({
                  to: phone,
                  text: `Namaskar ${ji}, I tried reaching you from ${brand}. Jab aap free hon, mujhe ek miss call / reply de dijiye — main dubara Tata line se callback arrange kar sakta hoon.`,
                });
                await db.query(
                  `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
                   VALUES ($1,$2,'whatsapp',$3,$4,$5::jsonb)`,
                  [
                    row.lead_id,
                    row.user_id,
                    'WhatsApp sent after unanswered Tata outbound attempt.',
                    'whatsapp_tata_recovery_ping',
                    JSON.stringify({
                      title: 'Tata no-answer / busy — WhatsApp nudge',
                      tataRecoverForCallId: providerCallId,
                      callStatus: st,
                      provider: 'tata',
                    }),
                  ]
                );
              }
            } catch (e) {
              logger.warn(`WhatsApp Tata recovery skipped: ${e.message}`);
            }
          }
        }
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error(`Tata webhook failed: ${err.message}`);
    return res.status(500).json({ ok: false });
  }
}

function whatsappVerifyWebhook(req, res) {
  const mode = String(req.query['hub.mode'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const expected = String(env.whatsapp?.webhookVerifyToken || '').trim();
  if (mode === 'subscribe' && expected && token === expected) {
    return res.status(200).send(challenge || 'ok');
  }
  return res.status(403).json({ ok: false, message: 'Webhook verification failed' });
}

async function whatsappInbound(req, res) {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider TEXT NOT NULL,
        provider_message_id TEXT UNIQUE NOT NULL,
        from_phone TEXT,
        payload JSONB NOT NULL,
        received_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const ch of changes) {
        const value = ch && ch.value && typeof ch.value === 'object' ? ch.value : {};
        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const msg of messages) {
          const messageId = String(msg?.id || '').trim();
          const from = normalizeDigits(msg.from || '');
          const text = extractInboundText(msg);
          if (!from || !text) continue;
          if (!messageId) continue;

          const dedupe = await db.query(
            `INSERT INTO whatsapp_webhook_events (provider, provider_message_id, from_phone, payload)
             VALUES ('meta_whatsapp_cloud', $1, $2, $3::jsonb)
             ON CONFLICT (provider_message_id) DO NOTHING
             RETURNING id`,
            [messageId, from, JSON.stringify(msg)]
          );
          if (!dedupe.rows[0]) continue;

          const lead = await findLeadByPhone(from);
          if (!lead) continue;
          const leadName = `${lead.contact_first_name || ''} ${lead.contact_last_name || ''}`.trim() || 'Lead';
          const actorUserId = lead.assigned_to || lead.user_id;
          const leadMd = lead.metadata && typeof lead.metadata === 'object' ? lead.metadata : {};

          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'whatsapp',$3,'whatsapp_inbound_lead',$4::jsonb)`,
            [
              lead.id,
              actorUserId,
              text,
              JSON.stringify({
                title: 'Inbound WhatsApp',
                sender: 'Lead',
                delivery: {
                  channel: 'whatsapp',
                  status: 'received',
                  provider: 'meta_whatsapp_cloud',
                  messageId: msg.id || null,
                },
              }),
            ]
          );
          await upsertLeadMetadata(lead.id, {
            lastInteraction: `Inbound WhatsApp: ${text.slice(0, 180)}`,
            lastActivityAt: new Date().toISOString(),
          });

          if (isStopIntent(text)) {
            await upsertLeadMetadata(lead.id, {
              whatsappOptOut: true,
              whatsappOptOutAt: new Date().toISOString(),
              aiScoreLabel: 'Lost',
              lastInteraction: 'Lead opted out on WhatsApp',
            });
            await db.query(
              `UPDATE sales_automation_jobs
               SET status = 'cancelled', updated_at = NOW()
               WHERE lead_id = $1
                 AND status IN ('pending', 'dispatched')
                 AND target_channel = 'whatsapp'`,
              [lead.id]
            );
            if (whatsappService.isWhatsAppEnabled()) {
              await whatsappService.sendWhatsAppText({
                to: lead.contact_phone || from,
                text: `Noted ${honorificNameJi(leadName) || 'there'} — we will stop WhatsApp outreach.`,
              });
            }
            continue;
          }

          if (asksForHuman(text)) {
            const takeoverUntilIso = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            await upsertLeadMetadata(lead.id, {
              whatsappHumanTakeoverMode: 'human',
              whatsappHumanTakeoverBy: actorUserId || null,
              whatsappHumanTakeoverUntil: takeoverUntilIso,
              lastInteraction: 'Lead asked for human support on WhatsApp',
            });
            await db.query(
              `INSERT INTO notifications (user_id, org_id, type, title, message, body, read, metadata, created_at)
               VALUES ($1,$2,'sales_automation',$3,$4,$4,false,$5::jsonb,NOW())`,
              [
                actorUserId,
                lead.org_id,
                'Lead requested human support',
                `${leadName} asked for human help on WhatsApp.`,
                JSON.stringify({ leadId: lead.id, channel: 'whatsapp', priority: 'critical' }),
              ]
            );
            if (whatsappService.isWhatsAppEnabled()) {
              await whatsappService.sendWhatsAppText({
                to: lead.contact_phone || from,
                text: `Thanks ${honorificNameJi(leadName) || ''}. A human teammate will continue this chat shortly.`,
              });
            }
            continue;
          }

          const takeoverUntil = new Date(String(leadMd.whatsappHumanTakeoverUntil || 0)).getTime();
          if (Number.isFinite(takeoverUntil) && takeoverUntil > Date.now()) {
            continue;
          }

          if (!whatsappService.isWhatsAppEnabled()) continue;
          const history = await buildWhatsAppHistory(lead.id);
          const humanPersona = await getUserHumanPersona(actorUserId).catch(() => 'friendly_consultant');
          const projectPrompt = await buildLeadProjectKnowledgePrompt({
            orgId: lead.org_id,
            leadMetadata: leadMd,
            queryText: text,
          });
          const systemPrompt = `${aiService.systemPromptForChat('whatsapp', {
            leadPreferredLocale: String(leadMd.preferredLocale || 'hing'),
            leadTimezone: String(leadMd.timezone || env.leadScheduleDefaultTz || 'Asia/Kolkata'),
            humanPersona,
          })}\n\n${projectPrompt}\n\nPolicy: AI-first support. Try to resolve unless critical risk or explicit human escalation is necessary.`;
          let aiReply = '';
          try {
            aiReply = await aiService.callAIWithMessages(history, systemPrompt, { temperature: 0.6 });
          } catch (e) {
            logger.warn(`WhatsApp AI reply fallback used: ${e?.message || e}`);
            aiReply = `Namaste ${honorificNameJi(leadName) || ''}, thanks for your message. I can help with project details, pricing, and next steps here.`;
          }
          aiReply = String(aiReply || '').trim().slice(0, 1800);
          if (!aiReply) continue;

          const sent = await whatsappService.sendWhatsAppText({
            to: lead.contact_phone || from,
            text: aiReply,
          });
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'whatsapp',$3,'whatsapp_ai_auto_reply',$4::jsonb)`,
            [
              lead.id,
              actorUserId,
              aiReply,
              JSON.stringify({
                title: 'AI WhatsApp auto-reply',
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
          await upsertLeadMetadata(lead.id, {
            lastInteraction: `Assist Pal reply: ${aiReply.slice(0, 180)}`,
            lastActivityAt: new Date().toISOString(),
          });

          const scheduleAt = inferImmediateOrTimedCall(text) || inferImmediateOrTimedCall(aiReply);
          if (scheduleAt && actorUserId) {
            const fingerprint = buildSimpleAutomationFingerprint(
              `wa-auto-call|${lead.id}|${new Date(scheduleAt).toISOString().slice(0, 16)}|${String(text || '').slice(0, 120)}`
            );
            const inserted = await db.query(
              `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
               VALUES ($1,$2,$3,'whatsapp','call',$4,$5::jsonb,$6)
               ON CONFLICT ON CONSTRAINT ux_sales_automation_jobs_pending_fingerprint DO NOTHING
               RETURNING id, schedule_at`,
              [
                lead.org_id,
                actorUserId,
                lead.id,
                scheduleAt,
                JSON.stringify({
                  inferred: true,
                  inferredFromWebhook: true,
                  contextHint: String(text || '').slice(0, 240),
                }),
                fingerprint,
              ]
            );
            if (inserted.rows[0]) {
              await db.query(
                `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
                 VALUES ($1,$2,'ai_action',$3,'automation_scheduled',$4::jsonb)`,
                [
                  lead.id,
                  actorUserId,
                  `Auto-scheduled call at ${new Date(inserted.rows[0].schedule_at).toLocaleString()} from WhatsApp intent.`,
                  JSON.stringify({
                    title: 'Auto Handshake Scheduled',
                    sourceChannel: 'whatsapp',
                    targetChannel: 'call',
                    scheduleAt: inserted.rows[0].schedule_at,
                    automationJobId: inserted.rows[0].id,
                    inferredFromWebhook: true,
                  }),
                ]
              );
            }
          }

          if (shouldStayIn24hWindow(text)) {
            await db.query(
              `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
               VALUES ($1,$2,$3,'whatsapp','whatsapp', NOW() + interval '23 hour 30 minute', $4::jsonb, $5)
               ON CONFLICT ON CONSTRAINT ux_sales_automation_jobs_pending_fingerprint DO NOTHING`,
              [
                lead.org_id,
                actorUserId,
                lead.id,
                JSON.stringify({
                  messageTemplate: '',
                  contextHint: '24h conversation window follow-up',
                  retryAttempt: 0,
                }),
                `wa-24h-window:${lead.id}:${new Date().toISOString().slice(0, 13)}`,
              ]
            );
          }
        }
      }
    }
    return res.json({ ok: true });
  } catch (err) {
    logger.error(`WhatsApp webhook failed: ${err.message}`);
    return res.status(500).json({ ok: false });
  }
}

module.exports = {
  tataCallStatus,
  whatsappVerifyWebhook,
  whatsappInbound,
};
