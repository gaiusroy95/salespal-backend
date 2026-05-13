const db = require('../config/db');
const crypto = require('crypto');
const aiService = require('../services/ai.service');
const analyticsService = require('../services/analytics.service');
const aiRuntime = require('../services/aiRuntime.service');
const sarvamService = require('../services/sarvam.service');
const env = require('../config/env');
const { streamVideoUriToResponse } = require('../services/aiVideo.service');
const { retrieveTopKSql } = require('../services/projectKnowledge.service');
const whatsappService = require('../services/whatsapp.service');
const callComplianceService = require('../services/callCompliance.service');
const { honorificNameJi } = require('../utils/voiceHonorifics');
const { parseNaturalScheduleUtcIso } = require('../utils/leadScheduleTz');
const { resolveLocaleFromDialCode } = require('../utils/voiceLocaleResolver');

const HARD_BLOCK_PATTERNS = [
  /\b(stop|do not call|don't call|unsubscribe|opt[-\s]?out)\b/i,
  /\b(bhenchod|madarchod|fuck you|bastard|harami|bc|mc)\b/i,
];
const SOFT_LOW_INTENT_PATTERNS = [/\btimepass|just checking|just browsing|not interested now\b/i];
const SERIOUS_INCIDENT_PATTERNS = [/\blegal notice|consumer court|police complaint|harassment complaint|fraud\b/i];

function classifyComplianceFromUtterance(text) {
  const t = String(text || '').trim();
  if (!t) return { mode: 'clear', reason: '' };
  if (HARD_BLOCK_PATTERNS.some((p) => p.test(t))) {
    const optOut = /\b(stop|do not call|don't call|unsubscribe|opt[-\s]?out)\b/i.test(t);
    return { mode: 'hard_block', reason: optOut ? 'user_opt_out' : 'explicit_abuse', serious: true };
  }
  if (SERIOUS_INCIDENT_PATTERNS.some((p) => p.test(t))) {
    return { mode: 'serious_incident', reason: 'legal_or_sensitive_complaint', serious: true };
  }
  if (SOFT_LOW_INTENT_PATTERNS.some((p) => p.test(t))) {
    return { mode: 'soft_low_intent', reason: 'low_intent_timepass', serious: false };
  }
  return { mode: 'clear', reason: '' };
}

async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

async function resolveLeadVoiceProfile(leadId, orgId) {
  if (!leadId || !orgId) return { gender: 'unknown', timezone: '', preferredLocale: 'hing' };
  try {
    const { rows } = await db.query(`SELECT metadata FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`, [leadId, orgId]);
    const md = rows[0]?.metadata && typeof rows[0].metadata === 'object' ? rows[0].metadata : {};
    const rawGender = String(md.voiceGender || md.gender || md.sex || '').toLowerCase();
    const gender = rawGender === 'male' || rawGender === 'female' ? rawGender : 'unknown';
    const timezone = String(md.leadTimezone || md.timezone || '').trim();
    const preferredLocale = String(md.preferredLocale || 'hing').toLowerCase().trim() || 'hing';
    return { gender, timezone, preferredLocale };
  } catch {
    return { gender: 'unknown', timezone: '', preferredLocale: 'hing' };
  }
}

/**
 * Many reps are not in `org_members` but leads still have `org_id`. Without this we skip project brief + RAG.
 */
async function resolveEffectiveOrgIdForVoice(userId, leadId, membershipOrgId) {
  if (membershipOrgId) return membershipOrgId;
  if (!userId || !leadId) return null;
  try {
    const { rows } = await db.query(
      `SELECT l.org_id
       FROM leads l
       WHERE l.id = $1
         AND (
           l.user_id = $2::uuid
           OR EXISTS (
             SELECT 1 FROM org_members m WHERE m.user_id = $2::uuid AND m.org_id IS NOT DISTINCT FROM l.org_id
           )
         )
       LIMIT 1`,
      [leadId, userId]
    );
    return rows[0]?.org_id || null;
  } catch (_) {
    return null;
  }
}

function sanitizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  for (const h of history) {
    if (!h || typeof h !== 'object') continue;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const content = String(h.content || '').trim();
    if (!content) continue;
    out.push({ role, content: content.slice(0, 8000) });
  }
  return out.slice(-40);
}

function detectVoiceHandshakeActions(text) {
  const t = String(text || '').toLowerCase();
  const actions = [];
  if (
    /(catalogue|catalog|brochure|price\s*list|send\s+(me\s+)?(the\s+)?(details|info|information|pdf)|project\s+pdf|whatsapp\s+send|send\s+.*whatsapp|matter\s+whatsapp|मुझे\s+कैटलॉग|भेजो|भेजिए|कैटलॉग|ब्रошर)/i.test(
      t
    )
  ) {
    actions.push({
      type: 'send_brochure_whatsapp',
      payload: { template: env.whatsapp?.catalogueTemplateName || 'project_catalogue' },
    });
  }
  const scheduleMatch = t.match(/call\s+(tomorrow|today)?\s*(?:at)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (scheduleMatch) {
    const hh = Number(scheduleMatch[2] || 9);
    const mm = Number(scheduleMatch[3] || 0);
    const ampm = String(scheduleMatch[4] || '').toLowerCase();
    let hour24 = hh;
    if (ampm === 'pm' && hh < 12) hour24 += 12;
    if (ampm === 'am' && hh === 12) hour24 = 0;
    const when = new Date();
    when.setDate(when.getDate() + 1);
    when.setHours(hour24, mm, 0, 0);
    actions.push({ type: 'schedule_followup_call', payload: { when: when.toISOString() } });
  }
  if (/(senior|manager|owner|supervisor)/i.test(t)) {
    actions.push({ type: 'escalate_to_senior_bot', payload: { mode: 'senior_male_commanding' } });
  }
  return actions;
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

function parseNaturalScheduleAt(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const now = new Date();
  const inHours = t.match(/\b(?:in|after)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/i);
  if (inHours) {
    const n = Number(inHours[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 3600000).toISOString();
  }
  const inMins = t.match(/\b(?:in|after)\s+(\d{1,3})\s*(minute|minutes|min|mins)\b/i);
  if (inMins) {
    const n = Number(inMins[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 60000).toISOString();
  }
  const dayOffset = /\btomorrow\b/i.test(t) ? 1 : 0;
  const tm = t.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (tm) {
    const hm = resolveHourMinute(tm[1], tm[2] || 0, tm[3] || '');
    if (hm) {
      const d = new Date(now);
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hm.hh, hm.mm, 0, 0);
      if (dayOffset === 0 && d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
  }
  return null;
}

function parseNaturalScheduleAtWithTimezone(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  const now = new Date();
  const inHours = t.match(/\b(?:in|after)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/i);
  if (inHours) {
    const n = Number(inHours[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 3600000).toISOString();
  }
  const inMins = t.match(/\b(?:in|after)\s+(\d{1,3})\s*(minute|minutes|min|mins)\b/i);
  if (inMins) {
    const n = Number(inMins[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 60000).toISOString();
  }
  return parseNaturalScheduleAt(text);
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

async function runVoiceCatalogueWhatsAppRelay({ session, orgId, userId, projectId }) {
  const phone = String(session?.phone || '').trim();
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (!whatsappService.isWhatsAppEnabled()) return { ok: false, reason: 'whatsapp_off' };
  const assetId = String(projectId || session.projectId || (session.metadata && session.metadata.projectId) || '').trim();
  const ji = honorificNameJi(String(session.name || '').trim());
  try {
    const tmpl = String(env.whatsapp?.catalogueTemplateName || '').trim();
    if (tmpl) {
      const bodyParameters = assetId ? [ji || 'Ji', assetId] : [ji || 'Ji'];
      await whatsappService.sendWhatsAppTemplate({
        to: phone,
        templateName: tmpl,
        languageCode: env.whatsapp?.catalogueTemplateLang || 'en',
        bodyParameters,
      });
    } else {
      const base = String(env.FRONTEND_URL || 'https://salespal.in').replace(/\/$/, '');
      const link = assetId ? `${base}/sales/leads?view=project&asset=${encodeURIComponent(assetId)}` : base;
      await whatsappService.sendWhatsAppText({
        to: phone,
        text: `Namaskar ${ji || 'Ji'}, yeh aapke liye project details ka link hai jo aapne voice call par maanga: ${link}`,
      });
    }

    if (session.leadId && userId) {
      await db.query(
        `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
         VALUES ($1,$2,'whatsapp',$3,$4,$5::jsonb)`,
        [
          session.leadId,
          userId,
          'Voice bot requested brochure — WhatsApp dispatched while call continued.',
          'voice_catalogue_whatsapp',
          JSON.stringify({
            title: 'Catalogue WhatsApp (voice)',
            projectId: assetId || null,
            conversationId: session.conversationId,
          }),
        ]
      ).catch(() => {});

      if (orgId) {
        const at = new Date(Date.now() + 23 * 3600 * 1000).toISOString();
        const fingerprint = buildAutomationFingerprint({
          sourceChannel: 'call',
          targetChannel: 'whatsapp',
          scheduleAt: at,
          text: `post_catalog_review:${session.leadId}:${assetId}`,
        });
        await db
          .query(
            `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
             VALUES ($1,$2,$3,'call','whatsapp',$4,$5::jsonb,$6)`,
            [
              orgId,
              userId,
              session.leadId,
              at,
              JSON.stringify({
                messageTemplate: `Namaskar ${ji}, kya brochure review kar paaye? Seedha boliye agar fir se Tata call arrange karoon.`,
                voiceFollowUp: 'post_catalog_23h',
              }),
              fingerprint,
            ]
          )
          .catch((err) => {
            if (String(err?.message || '').includes('ux_sales_automation_jobs_pending_fingerprint')) return;
            console.warn('[voice] post-catalog follow-up job insert:', err?.message || err);
          });
      }
    }

    return { ok: true, asset_id: assetId || null };
  } catch (e) {
    return { ok: false, reason: e?.message || 'send_failed' };
  }
}

/**
 * General AI chat endpoint.
 */
async function chat(req, res, next) {
  try {
    const { message, context, history, leadPreferredLocale, leadTimezone, projectId } = req.body;
    if (!message) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'message is required' } });

    try {
      let systemPrompt = aiService.systemPromptForChat(context, {
        leadPreferredLocale,
        leadTimezone,
      });
      const prior = sanitizeChatHistory(history);
      if (prior.length) {
        systemPrompt = `${systemPrompt}\nPrior turns are included below; stay consistent with the thread and respond mainly to the latest message unless the user asks for a recap.`;
      }
      if (context === 'whatsapp') {
        systemPrompt = `${systemPrompt}\n\nImportant: Earlier assistant messages may be in a different language — ignore their language. Match only the **latest user message** in the conversation.`;
      }
      if (projectId) {
        const orgId = await getOrgId(req.user.id);
        const top = await retrieveTopKSql({ projectId, orgId, queryText: String(message || ''), k: 6 });
        if (top.length) {
          const boundedContext = top.map((r) => `[${r.source_type}] ${r.content}`).join('\n---\n');
          systemPrompt = `${systemPrompt}\n\nProject Knowledge Boundary:\nUse ONLY the context below for factual business claims. If unknown, say so.\n${boundedContext}`;
        }
      }
      const chatMessages = [...prior, { role: 'user', content: String(message).trim().slice(0, 8000) }];
      const response = await aiService.callAIWithMessages(chatMessages, systemPrompt, {
        temperature: context === 'whatsapp' ? 0.6 : 0.7,
      });
      return res.json({ response, fallback: false });
    } catch (aiErr) {
      const reasonCode = aiErr?.code || 'AI_TEMPORARILY_UNAVAILABLE';
      const reasonMessage = String(aiErr?.message || 'AI temporarily unavailable');
      const fallbackResponse =
        reasonCode === 'AI_GEMINI_KEY_MISSING'
          ? 'Gemini key is not detected in the running backend runtime. If your local .env has it, set the same GOOGLE_GENERATIVE_AI_API_KEY on the deployed backend (e.g. Render) and redeploy.'
          : `AI is temporarily unavailable: ${reasonMessage}`;
      return res.json({
        response: fallbackResponse,
        fallback: true,
        reason: reasonCode,
        reason_message: reasonMessage,
      });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * AI campaign analysis endpoint.
 */
async function analyzeCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND org_id = $2`,
      [req.params.campaignId, orgId]
    );

    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    const prompt = aiService.buildCampaignAnalysisPrompt(rows[0]);
    const response = await aiService.callAI(prompt);

    res.json({ campaignId: req.params.campaignId, analysis: response });
  } catch (err) {
    next(err);
  }
}

/**
 * AI strategic insights based on aggregate analytics.
 */
async function getStrategicInsights(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ insights: 'No organization data available for analysis.' });

    const period = req.query.period || '30d';

    const [revenue, leads, platforms] = await Promise.all([
      analyticsService.getRevenueSummary(orgId, period),
      analyticsService.getLeadMetrics(orgId, period),
      analyticsService.getPlatformBreakdown(orgId, period),
    ]);

    const analyticsData = {
      ...revenue,
      ...leads,
      platforms,
    };

    const prompt = aiService.buildStrategicInsightsPrompt(analyticsData);
    const response = await aiService.callAI(prompt);

    res.json({ period, insights: response });
  } catch (err) {
    next(err);
  }
}

/**
 * AI ad copy generation endpoint.
 */
async function generateAdCopy(req, res, next) {
  try {
    const { productName, targetAudience, platform, objective, tone } = req.body;

    const prompt = `Generate marketing ad copy for the following:
Product/Service: ${productName}
Target Audience: ${targetAudience || 'General'}
Platform: ${platform || 'Facebook/Instagram'}
Objective: ${objective || 'Conversions'}
Tone: ${tone || 'Professional and engaging'}

Provide:
1. Headline (max 40 chars)
2. Primary text (max 125 chars)
3. Description (max 30 chars)
4. Call-to-action suggestion
5. Three variations of the headline`;

    const response = await aiService.callAI(prompt);
    res.json({ adCopy: response });
  } catch (err) {
    next(err);
  }
}

/**
 * Voice session start (internal runtime, persisted when DB is available).
 * Works for authenticated and demo routes.
 */
/**
 * Sarvam Bulbul TTS for browser playback (Gemini/Vertex = conversation brain).
 */
async function voiceSttTranscribe(req, res, next) {
  try {
    if (!sarvamService.isSarvamTtsConfigured(env)) {
      return res.status(503).json({
        error: { code: 'SARVAM_NOT_CONFIGURED', message: 'Sarvam is not configured (SARVAM_API_SUBSCRIPTION_KEY).' },
      });
    }
    const f = req.file;
    if (!f?.buffer?.length) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'audio file is required (multipart field: audio)' },
      });
    }
    const locale = String(req.body?.locale || 'hing').trim() || 'hing';
    const out = await sarvamService.transcribeBufferedAudio({
      env,
      buffer: f.buffer,
      filename: f.originalname || 'utterance.webm',
      mimeType: f.mimetype || '',
      locale,
    });
    res.json({ text: out.transcript, request_id: out.request_id });
  } catch (err) {
    next(err);
  }
}

async function voiceTts(req, res, next) {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'text is required' },
      });
    }
    if (!sarvamService.isSarvamTtsConfigured(env)) {
      return res.status(503).json({
        error: { code: 'SARVAM_NOT_CONFIGURED', message: 'Sarvam TTS is not configured (SARVAM_API_SUBSCRIPTION_KEY).' },
      });
    }
    const locale = String(req.body?.locale || 'hing').trim() || 'hing';
    const out = await sarvamService.synthesizeSpeech({ env, text, locale });
    res.json({
      mime_type: out.mimeType,
      audio_base64: out.buffer.toString('base64'),
    });
  } catch (err) {
    next(err);
  }
}

async function startVoiceSession(req, res, next) {
  try {
    const {
      leadId,
      phone,
      name,
      locale,
      brandId,
      mode,
      openerContext,
      projectId,
      agentName,
      voiceGenderDetected,
      mirrorSpokenLanguage,
      openerLocale,
    } = req.body || {};
    const effectiveBrandId = String(
      brandId || (req.user?.id ? `web-${req.user.id}` : 'web-demo')
    );
    const membershipOrgId = req.user?.id ? await getOrgId(req.user.id) : null;
    const userId = req.user?.id || null;
    const orgId =
      membershipOrgId || (req.user?.id && leadId ? await resolveEffectiveOrgIdForVoice(req.user.id, leadId, null) : null);
    const leadProfile = await resolveLeadVoiceProfile(leadId, orgId);
    const autoLocale = resolveLocaleFromDialCode(phone);
    const mirror = Boolean(mirrorSpokenLanguage);
    const openerTts = String(openerLocale || '').trim().toLowerCase() || null;
    let effectiveLocale = String(locale || '').trim() || autoLocale || 'hing';
    if (mirror) {
      effectiveLocale = 'hing';
    }
    const genderDetected = String(voiceGenderDetected || '').toLowerCase();
    const voiceGender =
      genderDetected === 'male' || genderDetected === 'female'
        ? genderDetected
        : leadProfile.gender || 'unknown';

    if (!phone && !leadId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'phone or leadId is required' },
      });
    }
    const { session, opener, telephony, voice_tts, voice_stt } = await aiRuntime.createVoiceSession({
      brandId: effectiveBrandId,
      leadId,
      phone,
      name,
      locale: effectiveLocale,
      mode,
      openerContext: openerContext || '',
      projectId: projectId || null,
      agentName: agentName || 'SalesPal AI',
      voiceGender,
      orgId,
      userId,
      mirrorSpokenLanguage: mirror,
      openerTtsLocale: mirror ? openerTts || String(leadProfile.preferredLocale || 'hing').toLowerCase() : null,
    });

    res.json({
      status: 'live',
      brand_id: session.brandId,
      lead_id: session.leadId,
      conversation_id: session.conversationId,
      locale_effective: session.locale,
      voice_gender_effective: voiceGender,
      control_mode: session?.metadata?.humanTakeoverActive ? 'human' : 'ai',
      assistant_reply: opener,
      telephony,
      voice_tts,
      voice_stt,
      state: session.state,
    });
  } catch (err) {
    if (String(err.code || '').startsWith('TATA_')) {
      return res.status(502).json({
        error: {
          code: err.code,
          message: err.message || 'Failed to place outbound call via Tata API.',
          details: err.details || null,
        },
      });
    }
    next(err);
  }
}

async function voiceTurn(req, res, next) {
  try {
    const { brandId, leadId, conversationId, text } = req.body || {};
    if (!text) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'text is required' },
      });
    }
    const effectiveBrandId = String(brandId || (req.user?.id ? `web-${req.user.id}` : 'web-demo'));
    const membershipOrgId = req.user?.id ? await getOrgId(req.user.id) : null;
    const userId = req.user?.id || null;
    const orgId =
      membershipOrgId ||
      (req.user?.id && leadId ? await resolveEffectiveOrgIdForVoice(req.user.id, leadId, null) : null);
    const compliance = classifyComplianceFromUtterance(text);

    const ensureVoiceActionsTable = async () => {
      await db.query(
        `CREATE TABLE IF NOT EXISTS ai_voice_actions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          conversation_id TEXT NOT NULL,
          org_id UUID,
          user_id UUID,
          action_type TEXT NOT NULL,
          payload JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`
      );
    };

    if (compliance.mode === 'hard_block' && conversationId && orgId && userId) {
      await ensureVoiceActionsTable();
      await aiRuntime.mergeVoiceSessionMetadata(
        conversationId,
        {
          humanTakeoverActive: true,
          aiSuppressedByCompliance: true,
          complianceMode: 'hard_block',
          complianceReason: compliance.reason,
        },
        { orgId, userId }
      );
      await db.query(
        `INSERT INTO ai_voice_actions (conversation_id, org_id, user_id, action_type, payload)
         VALUES ($1,$2,$3,'compliance_hard_block',$4::jsonb)`,
        [conversationId, orgId, userId, JSON.stringify({ reason: compliance.reason, text: String(text || '').slice(0, 500) })]
      );
      return res.json({
        status: 'ok',
        conversation_id: conversationId,
        assistant_reply:
          compliance.reason === 'user_opt_out'
            ? 'Understood. I will stop AI outreach for this conversation immediately.'
            : 'I am pausing this AI conversation now and marking it for human handling.',
        control_mode: 'human',
        compliance,
        done: true,
      });
    }
    const actions = detectVoiceHandshakeActions(text);
    let supervisorPrefix = '';

    if (actions.some((a) => a.type === 'escalate_to_senior_bot') && orgId && userId && conversationId) {
      await aiRuntime.mergeVoiceSessionMetadata(
        conversationId,
        { voicePersona: 'senior_male_ai_supervisor' },
        { orgId, userId }
      );
      supervisorPrefix = `I've brought in my senior supervisor for you.`;
    }

    const { session, reply, factSource } = await aiRuntime.handleVoiceTurn({
      brandId: effectiveBrandId,
      leadId,
      conversationId,
      text,
      orgId,
      userId,
    });
    let assistantReply =
      supervisorPrefix && reply
        ? `${supervisorPrefix} ${String(reply || '').trim()}`.trim()
        : supervisorPrefix || reply;
    let scheduledAutomation = null;
    let whatsappDispatch = null;

    if (actions.length || compliance.mode !== 'clear') {
      await ensureVoiceActionsTable();
    }
    if (actions.length) {
      for (const a of actions) {
        await db.query(
          `INSERT INTO ai_voice_actions (conversation_id, org_id, user_id, action_type, payload)
           VALUES ($1,$2,$3,$4,$5)`,
          [session.conversationId, orgId, userId, a.type, JSON.stringify(a.payload || {})]
        );
      }
    }

    if (compliance.mode !== 'clear' && conversationId && orgId && userId) {
      await db.query(
        `INSERT INTO ai_voice_actions (conversation_id, org_id, user_id, action_type, payload)
         VALUES ($1,$2,$3,'compliance_incident',$4::jsonb)`,
        [conversationId, orgId, userId, JSON.stringify({ mode: compliance.mode, reason: compliance.reason, text: String(text || '').slice(0, 500) })]
      );
    }

    if (actions.some((a) => a.type === 'send_brochure_whatsapp') && orgId && userId && session?.leadId) {
      const projectId = session.projectId || (session.metadata && session.metadata.projectId) || null;
      whatsappDispatch = await runVoiceCatalogueWhatsAppRelay({ session, orgId, userId, projectId });
      const ji = honorificNameJi(String(session.name || '').trim());
      if (whatsappDispatch?.ok) {
        assistantReply = `${String(assistantReply || '').trim()} I'm sending the project catalogue to your WhatsApp right now${ji ? `, ${ji}` : ''}.`.trim();
      }
    }

    let leadTzHint = '';
    if (session.leadId && orgId) {
      const { rows: lr } = await db.query(`SELECT metadata FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`, [
        session.leadId,
        orgId,
      ]);
      const m = lr[0]?.metadata && typeof lr[0].metadata === 'object' ? lr[0].metadata : {};
      leadTzHint = String(m.leadTimezone || m.timezone || m.preferredTimezone || '').trim();
    }
    const phoneForTz = String(session.phone || '').trim();

    const voiceContinuationSnippet =
      orgId && userId && session?.conversationId
        ? await aiRuntime.getVoiceTranscriptBrief(session.conversationId, { orgId, userId })
        : '';

    if (orgId && userId && session?.leadId) {
      const t = String(text || '').toLowerCase();
      const when = parseNaturalScheduleAtWithTimezone(text, { leadTimezoneHint: leadTzHint, leadPhone: phoneForTz });
      if (when) {
        const wantsChat = /(whatsapp|chat|message|text me|continue.*chat)/i.test(t);
        const wantsCall = /(call|phone call|ring|voice call)/i.test(t);
        let targetChannel = null;
        if (wantsChat) targetChannel = 'whatsapp';
        else if (wantsCall) targetChannel = 'call';
        if (targetChannel) {
          const fingerprint = buildAutomationFingerprint({
            sourceChannel: 'call',
            targetChannel,
            scheduleAt: when,
            text,
          });
          const existing = await db.query(
            `SELECT id
             FROM sales_automation_jobs
             WHERE org_id = $1
               AND user_id = $2
               AND lead_id = $3
               AND fingerprint = $4
               AND source_channel = 'call'
               AND target_channel = $5
               AND status = 'pending'
               AND ABS(EXTRACT(EPOCH FROM (schedule_at - $6::timestamptz))) <= 300
             LIMIT 1`,
            [orgId, userId, session.leadId, fingerprint, targetChannel, when]
          );
          if (existing.rows[0]) {
            if (targetChannel === 'whatsapp') {
              const at = new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              assistantReply = `${String(assistantReply || '').trim()} I will send you a WhatsApp message around ${at}.`.trim();
              scheduledAutomation = {
                sourceChannel: 'call',
                targetChannel: 'whatsapp',
                scheduleAt: when,
                duplicate: true,
              };
            }
            return res.json({
              status: 'ok',
              brand_id: session.brandId,
              lead_id: session.leadId,
              conversation_id: session.conversationId,
              assistant_reply: assistantReply,
              state: session.state,
              done: session.state === 'complete',
              fact_source: factSource || null,
              actions,
              scheduledAutomation,
              whatsapp_dispatch: whatsappDispatch,
            });
          }
          await db.query(
            `INSERT INTO sales_automation_jobs (org_id, user_id, lead_id, source_channel, target_channel, schedule_at, payload, fingerprint)
             VALUES ($1,$2,$3,'call',$4,$5,$6::jsonb,$7)`,
            [
              orgId,
              userId,
              session.leadId,
              targetChannel,
              when,
              JSON.stringify({
                inferred: true,
                inferredFrom: 'voice_turn',
                conversationId: session.conversationId,
                utterance: String(text || '').slice(0, 300),
                voiceContinuationSnippet,
              }),
              fingerprint,
            ]
          ).catch((err) => {
            if (String(err?.message || '').includes('ux_sales_automation_jobs_pending_fingerprint')) return null;
            throw err;
          });
          await db.query(
            `INSERT INTO lead_actions (lead_id, user_id, type, content, outcome, metadata)
             VALUES ($1,$2,'ai_action',$3,'automation_scheduled',$4::jsonb)`,
            [
              session.leadId,
              userId,
              `Auto-scheduled ${targetChannel} follow-up at ${new Date(when).toLocaleString()}`,
              JSON.stringify({
                title: 'Auto Handshake Scheduled',
                sourceChannel: 'call',
                targetChannel,
                scheduleAt: when,
                conversationId: session.conversationId,
              }),
            ]
          );
          if (targetChannel === 'whatsapp') {
            const at = new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            assistantReply = `${String(assistantReply || '').trim()} I will send you a WhatsApp message around ${at}.`.trim();
            scheduledAutomation = {
              sourceChannel: 'call',
              targetChannel: 'whatsapp',
              scheduleAt: when,
              duplicate: false,
            };
          }
        }
      }
    }
    let complianceAssistantNote = '';
    if (compliance.mode === 'soft_low_intent') {
      complianceAssistantNote = ' No worries — I can keep this brief and follow up only when you prefer.';
    }
    if (compliance.mode === 'serious_incident') {
      complianceAssistantNote = ' I am sorry for the inconvenience. I have flagged this for owner review and can arrange a human callback if needed.';
      if (whatsappService.isWhatsAppEnabled() && session?.phone) {
        const ji = honorificNameJi(String(session.name || '').trim()) || 'Ji';
        await whatsappService
          .sendWhatsAppText({
            to: session.phone,
            text: `Namaskar ${ji}, we are sorry for the inconvenience. Your concern has been flagged to our manager. Reply "CALL BACK" if you want a human callback.`,
          })
          .catch(() => {});
      }
      if (env.ownerWhatsappMsisdn && whatsappService.isWhatsAppEnabled()) {
        await whatsappService
          .sendWhatsAppText({
            to: env.ownerWhatsappMsisdn,
            text: `SalesPal compliance alert: serious voice incident (${compliance.reason}) for conversation ${session.conversationId}.`,
          })
          .catch(() => {});
      }
    }

    res.json({
      status: 'ok',
      brand_id: session.brandId,
      lead_id: session.leadId,
      conversation_id: session.conversationId,
      assistant_reply: `${assistantReply || ''}${complianceAssistantNote}`.trim(),
      state: session.state,
      done: session.state === 'complete',
      control_mode: session?.metadata?.humanTakeoverActive ? 'human' : 'ai',
      compliance,
      fact_source: factSource || null,
      actions,
      scheduledAutomation,
      whatsapp_dispatch: whatsappDispatch,
    });
  } catch (err) {
    next(err);
  }
}

async function moderateRealtimeVoice(req, res, next) {
  try {
    const { conversationId, text } = req.body || {};
    const verdict = classifyComplianceFromUtterance(text);
    if (verdict.mode === 'hard_block' && conversationId) {
      const orgId = req.user?.id ? await getOrgId(req.user.id) : null;
      const userId = req.user?.id || null;
      if (orgId && userId) {
        await aiRuntime.mergeVoiceSessionMetadata(
          conversationId,
          {
            humanTakeoverActive: true,
            aiSuppressedByCompliance: true,
            complianceMode: 'hard_block',
            complianceReason: verdict.reason,
          },
          { orgId, userId }
        );
      }
      await db
        .query(
          `INSERT INTO ai_voice_actions (conversation_id, org_id, user_id, action_type, payload)
           VALUES ($1,$2,$3,'realtime_compliance_block',$4::jsonb)`,
          [conversationId, orgId, userId, JSON.stringify({ reason: verdict.reason, text: String(text || '').slice(0, 500) })]
        )
        .catch(() => {});
    }
    res.json({
      ok: true,
      compliance: verdict,
      block_now: verdict.mode === 'hard_block',
      control_mode: verdict.mode === 'hard_block' ? 'human' : 'ai',
    });
  } catch (err) {
    next(err);
  }
}

async function ownerVoiceSummary(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ hotAlerts: [], summary: { totalCalls: 0, connected: 0, scheduledMeetings: 0 } });
    const [sessions, actions] = await Promise.all([
      db.query(
        `SELECT id, lead_id, contact_name, state, created_at
         FROM ai_voice_sessions
         WHERE org_id = $1 AND created_at::date = CURRENT_DATE`,
        [orgId]
      ),
      db.query(
        `SELECT action_type, payload, conversation_id, created_at
         FROM ai_voice_actions
         WHERE org_id = $1 AND created_at::date = CURRENT_DATE`,
        [orgId]
      ),
    ]);
    const totalCalls = sessions.rows.length;
    const connected = sessions.rows.filter((s) => s.state !== 'started').length;
    const scheduledMeetings = actions.rows.filter((a) => a.action_type === 'schedule_followup_call').length;
    const hotAlerts = actions.rows
      .filter((a) => a.action_type === 'escalate_to_senior_bot')
      .map((a) => ({ conversationId: a.conversation_id, createdAt: a.created_at, payload: a.payload }));
    res.json({ hotAlerts, summary: { totalCalls, connected, scheduledMeetings } });
  } catch (err) {
    next(err);
  }
}

async function voiceHistory(req, res, next) {
  try {
    const { brandId, leadId, conversationId } = req.query || {};
    const effectiveBrandId = String(
      brandId || (req.user?.id ? `web-${req.user.id}` : 'web-demo')
    );
    const orgId = req.user?.id ? await getOrgId(req.user.id) : null;
    const userId = req.user?.id || null;
    const session = await aiRuntime.getVoiceHistory(conversationId, { orgId, userId });
    if (!session) {
      return res.status(404).json({ error: { code: 'VOICE_SESSION_NOT_FOUND', message: 'Voice session not found' } });
    }
    res.json({
      brand_id: effectiveBrandId,
      lead_id: leadId || session.leadId,
      conversation_id: session.conversationId,
      state: session.state,
      locale: session.locale,
      turns: session.turns,
      turn_count: session.turns.length,
    });
  } catch (err) {
    next(err);
  }
}

async function voiceActions(req, res, next) {
  try {
    const { conversationId } = req.query || {};
    if (!conversationId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'conversationId is required' } });
    }
    const orgId = req.user?.id ? await getOrgId(req.user.id) : null;
    const userId = req.user?.id || null;
    try {
      const { rows } = await db.query(
        `SELECT id, action_type, payload, created_at
         FROM ai_voice_actions
         WHERE conversation_id = $1
           AND ($2::uuid IS NULL OR org_id = $2::uuid)
           AND ($3::uuid IS NULL OR user_id = $3::uuid OR user_id IS NULL)
         ORDER BY created_at DESC
         LIMIT 100`,
        [conversationId, orgId, userId]
      );
      return res.json({ conversation_id: conversationId, events: rows || [] });
    } catch (e) {
      // Table may not exist yet in older deployments.
      if (/ai_voice_actions/i.test(String(e?.message || ''))) {
        return res.json({ conversation_id: conversationId, events: [] });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
}

async function setVoiceConversationTakeover(req, res, next) {
  try {
    const { conversationId, mode } = req.body || {};
    if (!conversationId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'conversationId is required' } });
    }
    const normalizedMode = String(mode || 'human').toLowerCase();
    const human = normalizedMode !== 'ai';
    const orgId = req.user?.id ? await getOrgId(req.user.id) : null;
    const userId = req.user?.id || null;
    await aiRuntime.mergeVoiceSessionMetadata(
      conversationId,
      {
        humanTakeoverActive: human,
        humanTakeoverAt: new Date().toISOString(),
        humanTakeoverBy: userId || null,
      },
      { orgId, userId }
    );
    await db.query(
      `INSERT INTO ai_voice_actions (conversation_id, org_id, user_id, action_type, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [conversationId, orgId, userId, human ? 'human_takeover' : 'ai_resumed', JSON.stringify({ mode: human ? 'human' : 'ai' })]
    ).catch(() => {});
    res.json({ ok: true, conversationId, control_mode: human ? 'human' : 'ai' });
  } catch (err) {
    next(err);
  }
}

async function summarizeVoice(req, res, next) {
  try {
    const { brandId, leadId, conversationId } = req.body || {};
    const effectiveBrandId = String(
      brandId || (req.user?.id ? `web-${req.user.id}` : 'web-demo')
    );
    const orgId = req.user?.id ? await getOrgId(req.user.id) : null;
    const userId = req.user?.id || null;
    const { session, summary, summaryJson } = await aiRuntime.summarizeVoiceSession(conversationId, { orgId, userId });
    res.json({
      brand_id: effectiveBrandId,
      lead_id: leadId || session.leadId,
      conversation_id: session.conversationId,
      summary,
      summary_json: summaryJson,
      state: session.state,
    });
  } catch (err) {
    next(err);
  }
}

async function createVideoJob(req, res, next) {
  try {
    const { prompt, websiteUrl, brandName, objective, locale, durationSec, aspectRatio, referenceImageUrl } = req.body || {};
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'ORG_REQUIRED', message: 'User must belong to an organization' },
      });
    }
    const job = await aiRuntime.createVideoJob({
      prompt,
      websiteUrl,
      brandName,
      objective,
      locale,
      durationSec,
      aspectRatio,
      referenceImageUrl,
      orgId,
      userId: req.user.id,
    });
    aiRuntime.enqueueVideoJob(job.jobId, { orgId, durationSec, aspectRatio, referenceImageUrl });
    res.status(202).json({
      job_id: job.jobId,
      status: job.status,
      created_at: job.created_at,
    });
  } catch (err) {
    next(err);
  }
}

async function getVideoJob(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'ORG_REQUIRED', message: 'User must belong to an organization' },
      });
    }
    const job = await aiRuntime.getVideoJob(req.params.jobId, { orgId });
    if (!job) {
      return res.status(404).json({
        error: { code: 'VIDEO_JOB_NOT_FOUND', message: 'Video job not found' },
      });
    }
    res.json(job);
  } catch (err) {
    next(err);
  }
}

async function scanCallingScriptCompliance(req, res, next) {
  try {
    const script = String(req.body?.script || req.body?.text || '').trim();
    if (!script) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'script or text is required' } });
    }
    const result = await callComplianceService.scanCallingScript(script);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function streamVideoJobMedia(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'ORG_REQUIRED', message: 'User must belong to an organization' },
      });
    }
    const job = await aiRuntime.getVideoJob(req.params.jobId, { orgId });
    if (!job) {
      return res.status(404).json({
        error: { code: 'VIDEO_JOB_NOT_FOUND', message: 'Video job not found' },
      });
    }
    const videoUri =
      job.video_url ||
      job?.result?.video_url ||
      job?.result?.videoUrl ||
      job?.result?.clips?.[0]?.videoUrl ||
      null;
    if (!videoUri) {
      return res.status(409).json({
        error: { code: 'VIDEO_NOT_READY', message: 'Video URL is not available yet' },
      });
    }
    await streamVideoUriToResponse(videoUri, res, { range: req.headers.range });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  chat,
  analyzeCampaign,
  getStrategicInsights,
  generateAdCopy,
  startVoiceSession,
  voiceTts,
  voiceSttTranscribe,
  voiceTurn,
  setVoiceConversationTakeover,
  moderateRealtimeVoice,
  voiceHistory,
  voiceActions,
  summarizeVoice,
  ownerVoiceSummary,
  createVideoJob,
  getVideoJob,
  streamVideoJobMedia,
  scanCallingScriptCompliance,
};
