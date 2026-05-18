/**
 * Unified B2B sales engagement session — one account-aware brain across
 * voice (Tata PSTN), WhatsApp chat, and automation orchestration.
 *
 * Aligns with blueprint state machine; channel delivery stays in Tata/Meta services.
 */
const db = require('../config/db');
const logger = require('../config/logger');

/** Primary lifecycle states (blueprint). */
const ENGAGEMENT_STATES = Object.freeze({
  LEAD_CREATED: 'lead_created',
  PROFILE_NORMALIZED: 'profile_normalized',
  LANGUAGE_SELECTED: 'language_selected',
  CALL_ATTEMPT_STARTED: 'call_attempt_started',
  CALL_NO_ANSWER: 'call_no_answer',
  CALL_BUSY: 'call_busy',
  CALL_CONNECTED: 'call_connected',
  WHATSAPP_INTRO_SENT: 'whatsapp_intro_sent',
  CONVERSATION_ACTIVE: 'conversation_active',
  SHORT_EXIT: 'short_exit',
  BLOCKED_OR_EXIT: 'blocked_or_exit',
  QUALIFIED: 'qualified',
  PRIORITY_HANDLING: 'priority_handling',
  FOLLOWUP_FLOW: 'followup_flow',
  CAMPAIGN_FLOW: 'campaign_flow',
  VISIT_SCHEDULED: 'visit_scheduled',
  VISIT_RESCHEDULE: 'visit_reschedule',
  ESCALATION_REVIEW: 'escalation_review',
  SENIOR_AI_ENGAGED: 'senior_ai_engaged',
  HUMAN_INTERVENTION: 'human_intervention',
  OWNER_NOTIFIED: 'owner_notified',
  RATING_REQUESTED: 'rating_requested',
  SCORE_COMPUTED: 'score_computed',
  DASHBOARD_UPDATED: 'dashboard_updated',
  LEARNING_LOGGED: 'learning_logged',
});

/** Events that drive transitions (explicit, testable). */
const ENGAGEMENT_EVENTS = Object.freeze({
  LEAD_IMPORTED: 'LEAD_IMPORTED',
  PROFILE_NORMALIZED: 'PROFILE_NORMALIZED',
  LANGUAGE_DETECTED: 'LANGUAGE_DETECTED',
  CALL_OUTBOUND_STARTED: 'CALL_OUTBOUND_STARTED',
  CALL_INBOUND_CONNECTED: 'CALL_INBOUND_CONNECTED',
  CALL_CONNECTED: 'CALL_CONNECTED',
  CALL_NO_ANSWER: 'CALL_NO_ANSWER',
  CALL_BUSY: 'CALL_BUSY',
  WHATSAPP_INTRO_SENT: 'WHATSAPP_INTRO_SENT',
  WHATSAPP_INBOUND: 'WHATSAPP_INBOUND',
  WHATSAPP_OUTBOUND: 'WHATSAPP_OUTBOUND',
  CONVERSATION_TURN: 'CONVERSATION_TURN',
  SHORT_EXIT: 'SHORT_EXIT',
  BLOCKED: 'BLOCKED',
  QUALIFIED: 'QUALIFIED',
  HOT_LEAD: 'HOT_LEAD',
  WARM_LEAD: 'WARM_LEAD',
  COLD_LEAD: 'COLD_LEAD',
  CAMPAIGN_NUDGE: 'CAMPAIGN_NUDGE',
  VISIT_SCHEDULED: 'VISIT_SCHEDULED',
  VISIT_RESCHEDULED: 'VISIT_RESCHEDULED',
  ESCALATION_RISK: 'ESCALATION_RISK',
  SENIOR_AI: 'SENIOR_AI',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
  OWNER_NOTIFIED: 'OWNER_NOTIFIED',
  RATING_REQUESTED: 'RATING_REQUESTED',
  SCORE_UPDATED: 'SCORE_UPDATED',
  LEARNING_LOGGED: 'LEARNING_LOGGED',
});

/** from_state -> event -> to_state */
const TRANSITIONS = {
  [ENGAGEMENT_STATES.LEAD_CREATED]: {
    [ENGAGEMENT_EVENTS.LEAD_IMPORTED]: ENGAGEMENT_STATES.LEAD_CREATED,
    [ENGAGEMENT_EVENTS.PROFILE_NORMALIZED]: ENGAGEMENT_STATES.PROFILE_NORMALIZED,
    [ENGAGEMENT_EVENTS.LANGUAGE_DETECTED]: ENGAGEMENT_STATES.LANGUAGE_SELECTED,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
    [ENGAGEMENT_EVENTS.CALL_INBOUND_CONNECTED]: ENGAGEMENT_STATES.CALL_CONNECTED,
    [ENGAGEMENT_EVENTS.BLOCKED]: ENGAGEMENT_STATES.BLOCKED_OR_EXIT,
  },
  [ENGAGEMENT_STATES.PROFILE_NORMALIZED]: {
    [ENGAGEMENT_EVENTS.LANGUAGE_DETECTED]: ENGAGEMENT_STATES.LANGUAGE_SELECTED,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
    [ENGAGEMENT_EVENTS.CALL_INBOUND_CONNECTED]: ENGAGEMENT_STATES.CALL_CONNECTED,
  },
  [ENGAGEMENT_STATES.LANGUAGE_SELECTED]: {
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
    [ENGAGEMENT_EVENTS.CALL_INBOUND_CONNECTED]: ENGAGEMENT_STATES.CALL_CONNECTED,
    [ENGAGEMENT_EVENTS.WHATSAPP_INTRO_SENT]: ENGAGEMENT_STATES.WHATSAPP_INTRO_SENT,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
  },
  [ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED]: {
    [ENGAGEMENT_EVENTS.CALL_CONNECTED]: ENGAGEMENT_STATES.CALL_CONNECTED,
    [ENGAGEMENT_EVENTS.CALL_NO_ANSWER]: ENGAGEMENT_STATES.CALL_NO_ANSWER,
    [ENGAGEMENT_EVENTS.CALL_BUSY]: ENGAGEMENT_STATES.CALL_BUSY,
    [ENGAGEMENT_EVENTS.WHATSAPP_INTRO_SENT]: ENGAGEMENT_STATES.WHATSAPP_INTRO_SENT,
  },
  [ENGAGEMENT_STATES.CALL_NO_ANSWER]: {
    [ENGAGEMENT_EVENTS.WHATSAPP_INTRO_SENT]: ENGAGEMENT_STATES.WHATSAPP_INTRO_SENT,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
  },
  [ENGAGEMENT_STATES.CALL_BUSY]: {
    [ENGAGEMENT_EVENTS.WHATSAPP_INTRO_SENT]: ENGAGEMENT_STATES.WHATSAPP_INTRO_SENT,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
  },
  [ENGAGEMENT_STATES.CALL_CONNECTED]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_OUTBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.QUALIFIED]: ENGAGEMENT_STATES.QUALIFIED,
    [ENGAGEMENT_EVENTS.SHORT_EXIT]: ENGAGEMENT_STATES.SHORT_EXIT,
    [ENGAGEMENT_EVENTS.ESCALATION_RISK]: ENGAGEMENT_STATES.ESCALATION_REVIEW,
    [ENGAGEMENT_EVENTS.HUMAN_HANDOFF]: ENGAGEMENT_STATES.HUMAN_INTERVENTION,
  },
  [ENGAGEMENT_STATES.WHATSAPP_INTRO_SENT]: {
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_OUTBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
    [ENGAGEMENT_EVENTS.CALL_CONNECTED]: ENGAGEMENT_STATES.CALL_CONNECTED,
  },
  [ENGAGEMENT_STATES.CONVERSATION_ACTIVE]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_OUTBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
    [ENGAGEMENT_EVENTS.CALL_CONNECTED]: ENGAGEMENT_STATES.CALL_CONNECTED,
    [ENGAGEMENT_EVENTS.QUALIFIED]: ENGAGEMENT_STATES.QUALIFIED,
    [ENGAGEMENT_EVENTS.SHORT_EXIT]: ENGAGEMENT_STATES.SHORT_EXIT,
    [ENGAGEMENT_EVENTS.BLOCKED]: ENGAGEMENT_STATES.BLOCKED_OR_EXIT,
    [ENGAGEMENT_EVENTS.ESCALATION_RISK]: ENGAGEMENT_STATES.ESCALATION_REVIEW,
    [ENGAGEMENT_EVENTS.HUMAN_HANDOFF]: ENGAGEMENT_STATES.HUMAN_INTERVENTION,
    [ENGAGEMENT_EVENTS.VISIT_SCHEDULED]: ENGAGEMENT_STATES.VISIT_SCHEDULED,
    [ENGAGEMENT_EVENTS.VISIT_RESCHEDULED]: ENGAGEMENT_STATES.VISIT_RESCHEDULE,
    [ENGAGEMENT_EVENTS.CAMPAIGN_NUDGE]: ENGAGEMENT_STATES.CAMPAIGN_FLOW,
    [ENGAGEMENT_EVENTS.RATING_REQUESTED]: ENGAGEMENT_STATES.RATING_REQUESTED,
  },
  [ENGAGEMENT_STATES.QUALIFIED]: {
    [ENGAGEMENT_EVENTS.HOT_LEAD]: ENGAGEMENT_STATES.PRIORITY_HANDLING,
    [ENGAGEMENT_EVENTS.WARM_LEAD]: ENGAGEMENT_STATES.FOLLOWUP_FLOW,
    [ENGAGEMENT_EVENTS.COLD_LEAD]: ENGAGEMENT_STATES.CAMPAIGN_FLOW,
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.VISIT_SCHEDULED]: ENGAGEMENT_STATES.VISIT_SCHEDULED,
    [ENGAGEMENT_EVENTS.ESCALATION_RISK]: ENGAGEMENT_STATES.ESCALATION_REVIEW,
  },
  [ENGAGEMENT_STATES.PRIORITY_HANDLING]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.SENIOR_AI]: ENGAGEMENT_STATES.SENIOR_AI_ENGAGED,
    [ENGAGEMENT_EVENTS.HUMAN_HANDOFF]: ENGAGEMENT_STATES.HUMAN_INTERVENTION,
    [ENGAGEMENT_EVENTS.OWNER_NOTIFIED]: ENGAGEMENT_STATES.OWNER_NOTIFIED,
    [ENGAGEMENT_EVENTS.SCORE_UPDATED]: ENGAGEMENT_STATES.SCORE_COMPUTED,
  },
  [ENGAGEMENT_STATES.FOLLOWUP_FLOW]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_OUTBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
    [ENGAGEMENT_EVENTS.SCORE_UPDATED]: ENGAGEMENT_STATES.SCORE_COMPUTED,
  },
  [ENGAGEMENT_STATES.CAMPAIGN_FLOW]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CAMPAIGN_NUDGE]: ENGAGEMENT_STATES.CAMPAIGN_FLOW,
  },
  [ENGAGEMENT_STATES.VISIT_SCHEDULED]: {
    [ENGAGEMENT_EVENTS.VISIT_RESCHEDULED]: ENGAGEMENT_STATES.VISIT_RESCHEDULE,
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.SCORE_UPDATED]: ENGAGEMENT_STATES.SCORE_COMPUTED,
  },
  [ENGAGEMENT_STATES.VISIT_RESCHEDULE]: {
    [ENGAGEMENT_EVENTS.VISIT_SCHEDULED]: ENGAGEMENT_STATES.VISIT_SCHEDULED,
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
  },
  [ENGAGEMENT_STATES.ESCALATION_REVIEW]: {
    [ENGAGEMENT_EVENTS.SENIOR_AI]: ENGAGEMENT_STATES.SENIOR_AI_ENGAGED,
    [ENGAGEMENT_EVENTS.HUMAN_HANDOFF]: ENGAGEMENT_STATES.HUMAN_INTERVENTION,
    [ENGAGEMENT_EVENTS.OWNER_NOTIFIED]: ENGAGEMENT_STATES.OWNER_NOTIFIED,
  },
  [ENGAGEMENT_STATES.SENIOR_AI_ENGAGED]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.HUMAN_HANDOFF]: ENGAGEMENT_STATES.HUMAN_INTERVENTION,
  },
  [ENGAGEMENT_STATES.HUMAN_INTERVENTION]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.SCORE_UPDATED]: ENGAGEMENT_STATES.SCORE_COMPUTED,
  },
  [ENGAGEMENT_STATES.OWNER_NOTIFIED]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.LEARNING_LOGGED]: ENGAGEMENT_STATES.LEARNING_LOGGED,
  },
  [ENGAGEMENT_STATES.RATING_REQUESTED]: {
    [ENGAGEMENT_EVENTS.SCORE_UPDATED]: ENGAGEMENT_STATES.SCORE_COMPUTED,
    [ENGAGEMENT_EVENTS.LEARNING_LOGGED]: ENGAGEMENT_STATES.LEARNING_LOGGED,
  },
  [ENGAGEMENT_STATES.SCORE_COMPUTED]: {
    [ENGAGEMENT_EVENTS.LEARNING_LOGGED]: ENGAGEMENT_STATES.LEARNING_LOGGED,
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
  },
  [ENGAGEMENT_STATES.SHORT_EXIT]: {
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED]: ENGAGEMENT_STATES.CALL_ATTEMPT_STARTED,
  },
  [ENGAGEMENT_STATES.BLOCKED_OR_EXIT]: {},
  [ENGAGEMENT_STATES.LEARNING_LOGGED]: {
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
    [ENGAGEMENT_EVENTS.WHATSAPP_INBOUND]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
  },
  [ENGAGEMENT_STATES.DASHBOARD_UPDATED]: {
    [ENGAGEMENT_EVENTS.LEARNING_LOGGED]: ENGAGEMENT_STATES.LEARNING_LOGGED,
    [ENGAGEMENT_EVENTS.CONVERSATION_TURN]: ENGAGEMENT_STATES.CONVERSATION_ACTIVE,
  },
};

const GLOBAL_EVENTS = new Set([
  ENGAGEMENT_EVENTS.BLOCKED,
  ENGAGEMENT_EVENTS.HUMAN_HANDOFF,
  ENGAGEMENT_EVENTS.ESCALATION_RISK,
]);

function resolveNextState(currentState, event) {
  const from = currentState || ENGAGEMENT_STATES.LEAD_CREATED;
  const table = TRANSITIONS[from] || {};
  if (table[event]) return table[event];
  if (GLOBAL_EVENTS.has(event)) {
    if (event === ENGAGEMENT_EVENTS.BLOCKED) return ENGAGEMENT_STATES.BLOCKED_OR_EXIT;
    if (event === ENGAGEMENT_EVENTS.HUMAN_HANDOFF) return ENGAGEMENT_STATES.HUMAN_INTERVENTION;
    if (event === ENGAGEMENT_EVENTS.ESCALATION_RISK) return ENGAGEMENT_STATES.ESCALATION_REVIEW;
  }
  return null;
}

function mapTataCallStatusToEvent(callStatus) {
  const st = String(callStatus || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '');
  if (!st) return null;
  if (/(answered|connected|in[-_]?progress|bridge|talking|completed|complete)/.test(st)) {
    return ENGAGEMENT_EVENTS.CALL_CONNECTED;
  }
  if (/(no[-_]?answer|not[-_]?answered|unanswered|missed)/.test(st)) {
    return ENGAGEMENT_EVENTS.CALL_NO_ANSWER;
  }
  if (/(busy|user_busy)/.test(st)) {
    return ENGAGEMENT_EVENTS.CALL_BUSY;
  }
  if (/(ring|dial|initiat|start|queued|trying)/.test(st)) {
    return ENGAGEMENT_EVENTS.CALL_OUTBOUND_STARTED;
  }
  return null;
}

function inferLeadTypeFromStageAndScore(stage, aiScore) {
  const s = String(stage || 'new').toLowerCase();
  const score = Number(aiScore);
  if (['proposal', 'closed_won'].includes(s) || (Number.isFinite(score) && score >= 75)) return 'hot';
  if (['qualified', 'contacted'].includes(s) || (Number.isFinite(score) && score >= 45)) return 'warm';
  return 'cold';
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    leadId: row.lead_id,
    userId: row.user_id,
    state: row.state,
    preferredLocale: row.preferred_locale,
    timezone: row.timezone,
    leadType: row.lead_type,
    qualification: row.qualification && typeof row.qualification === 'object' ? row.qualification : {},
    lastCallSummary: row.last_call_summary,
    lastWhatsappSummary: row.last_whatsapp_summary,
    activeVoiceConversationId: row.active_voice_conversation_id,
    promises: Array.isArray(row.promises) ? row.promises : [],
    objections: Array.isArray(row.objections) ? row.objections : [],
    sharedFiles: Array.isArray(row.shared_files) ? row.shared_files : [],
    meetingStatus: row.meeting_status,
    visitStatus: row.visit_status,
    aiScore: row.ai_score,
    escalationRisk: row.escalation_risk,
    nextAction: row.next_action,
    nextActionAt: row.next_action_at,
    humanTakeover: Boolean(row.human_takeover),
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getSessionByLeadId(leadId) {
  const { rows } = await db.query(
    `SELECT * FROM sales_engagement_sessions WHERE lead_id = $1 LIMIT 1`,
    [leadId]
  );
  return mapRow(rows[0]);
}

async function getOrCreateSession({ orgId, leadId, userId, leadRow = null }) {
  if (!orgId || !leadId) return null;
  const existing = await getSessionByLeadId(leadId);
  if (existing) return existing;

  let lead = leadRow;
  if (!lead) {
    const { rows } = await db.query(
      `SELECT id, org_id, user_id, stage, ai_score, metadata, contact_first_name, contact_last_name, company_name
       FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [leadId, orgId]
    );
    lead = rows[0];
  }
  if (!lead) return null;

  const md = lead.metadata && typeof lead.metadata === 'object' ? lead.metadata : {};
  const preferredLocale = String(md.preferredLocale || md.preferred_locale || 'hing').slice(0, 32) || 'hing';
  const timezone = String(md.timezone || md.leadTimezone || 'Asia/Kolkata').slice(0, 64) || 'Asia/Kolkata';
  const leadType = inferLeadTypeFromStageAndScore(lead.stage, lead.ai_score);
  const humanTakeover = Boolean(md.whatsappHumanTakeoverMode === 'human' || md.humanTakeoverActive);

  const { rows } = await db.query(
    `INSERT INTO sales_engagement_sessions (
       org_id, lead_id, user_id, state, preferred_locale, timezone, lead_type,
       ai_score, human_takeover, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (lead_id) DO NOTHING
     RETURNING *`,
    [
      orgId,
      leadId,
      userId || lead.user_id || null,
      ENGAGEMENT_STATES.LEAD_CREATED,
      preferredLocale,
      timezone,
      leadType,
      lead.ai_score ?? null,
      humanTakeover,
      JSON.stringify({ source: 'getOrCreateSession' }),
    ]
  );

  if (rows[0]) {
    await db.query(
      `INSERT INTO sales_engagement_events (session_id, lead_id, from_state, to_state, event, channel, metadata)
       VALUES ($1,$2,NULL,$3,$4,'system',$5::jsonb)`,
      [
        rows[0].id,
        leadId,
        ENGAGEMENT_STATES.LEAD_CREATED,
        ENGAGEMENT_EVENTS.LEAD_IMPORTED,
        JSON.stringify({ company: lead.company_name || null }),
      ]
    );
    if (lead.contact_phone && (lead.contact_first_name || lead.contact_last_name)) {
      await applyEvent({
        leadId,
        event: ENGAGEMENT_EVENTS.PROFILE_NORMALIZED,
        channel: 'system',
        metadata: {},
        orgId,
      }).catch(() => {});
    }
    return mapRow(rows[0]);
  }
  return getSessionByLeadId(leadId);
}

async function patchSession(leadId, patch = {}) {
  if (!leadId || !patch || typeof patch !== 'object') return null;
  const sets = [];
  const vals = [];
  let i = 1;

  const fieldMap = {
    preferredLocale: 'preferred_locale',
    timezone: 'timezone',
    leadType: 'lead_type',
    qualification: 'qualification',
    lastCallSummary: 'last_call_summary',
    lastWhatsappSummary: 'last_whatsapp_summary',
    activeVoiceConversationId: 'active_voice_conversation_id',
    promises: 'promises',
    objections: 'objections',
    sharedFiles: 'shared_files',
    meetingStatus: 'meeting_status',
    visitStatus: 'visit_status',
    aiScore: 'ai_score',
    escalationRisk: 'escalation_risk',
    nextAction: 'next_action',
    nextActionAt: 'next_action_at',
    humanTakeover: 'human_takeover',
    metadata: 'metadata',
    userId: 'user_id',
  };

  for (const [k, col] of Object.entries(fieldMap)) {
    if (patch[k] === undefined) continue;
    let v = patch[k];
    if (['qualification', 'promises', 'objections', 'sharedFiles', 'metadata'].includes(k)) {
      v = JSON.stringify(v);
      sets.push(`${col} = $${i}::jsonb`);
    } else {
      sets.push(`${col} = $${i}`);
    }
    vals.push(v);
    i += 1;
  }
  if (!sets.length) return getSessionByLeadId(leadId);
  sets.push('updated_at = NOW()');
  vals.push(leadId);
  const { rows } = await db.query(
    `UPDATE sales_engagement_sessions SET ${sets.join(', ')} WHERE lead_id = $${i} RETURNING *`,
    vals
  );
  return mapRow(rows[0]);
}

/**
 * Apply a state-machine event for a lead. Updates session row + append-only event log.
 */
async function applyEvent({ leadId, event, channel = 'system', metadata = {}, orgId = null, patch = null }) {
  if (!leadId || !event) return { ok: false, reason: 'missing_lead_or_event' };

  let session = await getSessionByLeadId(leadId);
  if (!session && orgId) {
    session = await getOrCreateSession({ orgId, leadId });
  }
  if (!session) {
    const { rows: leadOnly } = await db.query(`SELECT org_id, user_id FROM leads WHERE id = $1 LIMIT 1`, [leadId]);
    if (leadOnly[0]?.org_id) {
      session = await getOrCreateSession({ orgId: leadOnly[0].org_id, leadId, userId: leadOnly[0].user_id });
    }
  }
  if (!session) return { ok: false, reason: 'no_session' };

  const fromState = session.state;
  const nextState = resolveNextState(fromState, event);
  const toState = nextState || fromState;

  if (patch && typeof patch === 'object') {
    await patchSession(leadId, patch);
  }

  if (toState !== fromState) {
    await db.query(
      `UPDATE sales_engagement_sessions SET state = $2, updated_at = NOW() WHERE lead_id = $1`,
      [leadId, toState]
    );
  }

  await db.query(
    `INSERT INTO sales_engagement_events (session_id, lead_id, from_state, to_state, event, channel, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      session.id,
      leadId,
      fromState,
      toState,
      event,
      channel,
      JSON.stringify(metadata || {}),
    ]
  );

  logger.info('[sales-engagement] transition', {
    leadId,
    fromState,
    toState,
    event,
    channel,
    changed: toState !== fromState,
  });

  return { ok: true, fromState, toState, event, sessionId: session.id };
}

async function recordConversationSnippet({
  leadId,
  channel,
  role,
  text,
  orgId = null,
  conversationId = null,
}) {
  const snippet = String(text || '').trim().slice(0, 500);
  if (!snippet || !leadId) return;

  const patch = {};
  if (channel === 'voice_pstn' || channel === 'voice_browser') {
    patch.lastCallSummary = snippet;
    if (conversationId) patch.activeVoiceConversationId = conversationId;
  } else if (channel === 'whatsapp_chat') {
    patch.lastWhatsappSummary = snippet;
  }

  if (orgId) await getOrCreateSession({ orgId, leadId });
  await patchSession(leadId, patch);

  const evt =
    role === 'user'
      ? channel.startsWith('whatsapp')
        ? ENGAGEMENT_EVENTS.WHATSAPP_INBOUND
        : ENGAGEMENT_EVENTS.CONVERSATION_TURN
      : channel.startsWith('whatsapp')
        ? ENGAGEMENT_EVENTS.WHATSAPP_OUTBOUND
        : ENGAGEMENT_EVENTS.CONVERSATION_TURN;

  await applyEvent({
    leadId,
    event: evt,
    channel,
    metadata: { role, snippetLen: snippet.length, conversationId: conversationId || null },
    orgId,
  });
}

async function syncQualificationFromText(leadId, text) {
  const t = String(text || '').toLowerCase();
  const patch = { qualification: {} };
  const session = await getSessionByLeadId(leadId);
  const q = session?.qualification && typeof session.qualification === 'object' ? { ...session.qualification } : {};

  if (/\b(budget|price|cost|emi|lakh|crore|rs\.?)\b/i.test(t)) q.budgetMentioned = true;
  if (/\b(need|looking for|interested in|require)\b/i.test(t)) q.needMentioned = true;
  if (/\b(month|week|day|timeline|when|possession|ready)\b/i.test(t)) q.timelineMentioned = true;
  if (/\b(visit|site visit|walkthrough|meeting)\b/i.test(t)) {
    q.visitIntent = true;
    await applyEvent({ leadId, event: ENGAGEMENT_EVENTS.VISIT_SCHEDULED, channel: 'system', metadata: { from: 'nlp' } }).catch(
      () => {}
    );
  }
  if (/\b(human|manager|owner|person|agent)\b/i.test(t)) {
    await applyEvent({
      leadId,
      event: ENGAGEMENT_EVENTS.HUMAN_HANDOFF,
      channel: 'system',
      metadata: { from: 'nlp' },
      patch: { humanTakeover: true },
    }).catch(() => {});
  }

  if (Object.keys(q).length) {
    await patchSession(leadId, { qualification: q });
  }
}

/**
 * Cross-channel context block for AI prompts (voice + WhatsApp).
 */
async function buildEngagementPromptBlock(leadId) {
  const session = await getSessionByLeadId(leadId);
  if (!session) return '';

  const lines = [
    'UNIFIED ENGAGEMENT SESSION (same executive across call + WhatsApp — do not re-ask baseline questions already covered):',
    `- Lifecycle state: ${session.state}`,
    `- Preferred language: ${session.preferredLocale} (mirror lead's latest message language)`,
    `- Timezone: ${session.timezone}`,
  ];
  if (session.leadType) lines.push(`- Lead temperature: ${session.leadType}`);
  if (session.lastCallSummary) lines.push(`- Last voice interaction: ${session.lastCallSummary}`);
  if (session.lastWhatsappSummary) lines.push(`- Last WhatsApp interaction: ${session.lastWhatsappSummary}`);
  if (session.meetingStatus) lines.push(`- Meeting status: ${session.meetingStatus}`);
  if (session.visitStatus) lines.push(`- Visit status: ${session.visitStatus}`);
  if (session.nextAction) {
    lines.push(
      `- Pending next step: ${session.nextAction}${session.nextActionAt ? ` (by ${session.nextActionAt})` : ''}`
    );
  }
  const q = session.qualification || {};
  const qParts = [];
  if (q.needMentioned) qParts.push('need discussed');
  if (q.budgetMentioned) qParts.push('budget discussed');
  if (q.timelineMentioned) qParts.push('timeline discussed');
  if (q.visitIntent) qParts.push('visit interest');
  if (qParts.length) lines.push(`- Qualification signals: ${qParts.join(', ')}`);
  if (session.humanTakeover) {
    lines.push('- Human takeover is active — defer commercial negotiation to the human owner.');
  }
  if (session.escalationRisk === 'high' || session.escalationRisk === 'critical') {
    lines.push('- Escalation risk is elevated — be careful with commitments; offer senior/human help if needed.');
  }
  lines.push(
    '- Continue the same thread: reference prior commitments naturally; never sound like a fresh bot on each channel.'
  );
  return `${lines.join('\n')}\n`;
}

async function listEngagementEvents(leadId, limit = 50) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const { rows } = await db.query(
    `SELECT id, from_state, to_state, event, channel, metadata, created_at
     FROM sales_engagement_events
     WHERE lead_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [leadId, lim]
  );
  return rows;
}

module.exports = {
  ENGAGEMENT_STATES,
  ENGAGEMENT_EVENTS,
  getSessionByLeadId,
  getOrCreateSession,
  applyEvent,
  patchSession,
  recordConversationSnippet,
  syncQualificationFromText,
  buildEngagementPromptBlock,
  listEngagementEvents,
  mapTataCallStatusToEvent,
  inferLeadTypeFromStageAndScore,
};
