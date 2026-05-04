const db = require('../config/db');
const env = require('../config/env');
const logger = require('../config/logger');
const whatsappService = require('../services/whatsapp.service');
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

module.exports = {
  tataCallStatus,
};
