/**
 * Seed unified session context before the first spoken audio turn.
 * Gemini Live: use clientContent turns (send_client_content pattern).
 * Sarvam/REST bridge: persist seed on ai_voice_sessions.metadata + prompt injection.
 */
const db = require('../config/db');
const salesEngagement = require('./salesEngagement.service');
const { resolveVoiceStackProfile } = require('../config/voiceStackProfiles');
const logger = require('../config/logger');

async function loadLeadContext(leadId, orgId) {
  if (!leadId) return null;
  const { rows } = await db.query(
    `SELECT id, org_id, contact_first_name, contact_last_name, company_name, contact_phone, metadata, stage, ai_score
     FROM leads WHERE id = $1 ${orgId ? 'AND org_id = $2' : ''} LIMIT 1`,
    orgId ? [leadId, orgId] : [leadId]
  );
  return rows[0] || null;
}

async function loadRecentVoiceTurns(conversationId, limit = 6) {
  if (!conversationId) return [];
  const { rows } = await db.query(
    `SELECT role, content FROM ai_voice_turns
     WHERE conversation_id = $1 AND role IN ('user', 'assistant')
     ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse();
}

function honorificName(first, last) {
  const full = `${first || ''} ${last || ''}`.trim();
  if (!full) return 'the caller';
  const firstPart = full.split(/\s+/)[0];
  return `${firstPart} Ji`;
}

/**
 * Build seed payload for a voice session (call before first TTS / Gemini Live connect).
 */
async function buildVoiceSessionSeed({
  conversationId,
  leadId,
  orgId,
  userId,
  contactName,
  projectName,
  profileId,
}) {
  const profile = resolveVoiceStackProfile(profileId);
  const seedCfg = profile.contextSeed || {};
  const lead = leadId ? await loadLeadContext(leadId, orgId) : null;
  const engagementBlock = leadId
    ? await salesEngagement.buildEngagementPromptBlock(leadId).catch(() => '')
    : '';

  const displayName =
    contactName ||
    (lead ? `${lead.contact_first_name || ''} ${lead.contact_last_name || ''}`.trim() : '') ||
    'the caller';
  const company = lead?.company_name || '';
  const locale =
    (lead?.metadata && typeof lead.metadata === 'object' && lead.metadata.preferredLocale) || 'hing';
  const stage = lead?.stage || 'new';

  const lines = [
    'SESSION CONTEXT (already known — do NOT re-ask baseline discovery):',
    `- Lead name: ${displayName} (address as ${honorificName(lead?.contact_first_name, lead?.contact_last_name)})`,
  ];
  if (company) lines.push(`- Company: ${company}`);
  if (projectName) lines.push(`- Active listing / project: ${projectName}`);
  lines.push(`- Preferred language baseline: ${locale}`);
  lines.push(`- CRM stage: ${stage}`);
  if (engagementBlock) lines.push('', engagementBlock.trim());

  const forbidName =
    seedCfg.forbidReaskingName !== false
      ? '\nRULE: You already know this person from CRM and/or a prior call or WhatsApp. Never ask "aap ka naam kya hai" or repeat a full cold intro.'
      : '';

  const systemInstruction = `You are a trained B2B inside-sales executive on a live phone call.${forbidName}
${lines.join('\n')}
Continue naturally from this context on every channel (voice and WhatsApp).`;

  let priorTurns = [];
  if (seedCfg.includeVoiceTurnHistory && conversationId) {
    priorTurns = await loadRecentVoiceTurns(conversationId, 4);
  }

  const clientContent = [];
  if (profile.contextSeed?.method === 'send_client_content') {
    const contextUserText = [
      'Internal briefing before the call connects (not spoken to the lead):',
      lines.join('\n'),
      priorTurns.length
        ? `Recent transcript:\n${priorTurns.map((t) => `${t.role}: ${String(t.content || '').slice(0, 280)}`).join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    clientContent.push(
      { role: 'user', parts: [{ text: contextUserText.slice(0, 6000) }] },
      {
        role: 'model',
        parts: [
          {
            text: 'Understood. I will continue as one consistent sales executive, use Brain Drive facts when available, and mirror the lead language without re-asking their name.',
          },
        ],
      }
    );
  }

  return {
    profileId: profile.id,
    method: profile.contextSeed?.method || 'prompt_injection',
    systemInstruction,
    clientContent,
    promptBlock: `${systemInstruction}\n`,
    seededAt: new Date().toISOString(),
    leadId: leadId || null,
    conversationId: conversationId || null,
  };
}

async function persistSeedToVoiceSession(conversationId, seed) {
  if (!conversationId || !seed) return;
  try {
    await db.query(
      `UPDATE ai_voice_sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
           updated_at = NOW()
       WHERE conversation_id = $1`,
      [
        conversationId,
        JSON.stringify({
          voiceContextSeed: {
            seededAt: seed.seededAt,
            method: seed.method,
            profileId: seed.profileId,
            systemInstruction: seed.systemInstruction.slice(0, 8000),
            clientContent: seed.clientContent,
            promptBlock: seed.promptBlock.slice(0, 8000),
          },
          voiceContextSeeded: true,
        }),
      ]
    );
  } catch (e) {
    logger.warn('[voiceContextSeed] persist failed', { conversationId, error: e.message });
  }
}

async function seedBeforeFirstAudio(session) {
  if (!session?.conversationId || session.contextSeeded) return null;

  let leadId = session.leadId || null;
  if (!leadId) {
    try {
      const { rows } = await db.query(
        `SELECT lead_id FROM ai_voice_sessions WHERE conversation_id = $1 LIMIT 1`,
        [session.conversationId]
      );
      leadId = rows[0]?.lead_id || null;
      if (leadId) session.leadId = leadId;
    } catch (_) {
      /* non-fatal */
    }
  }

  const seed = await buildVoiceSessionSeed({
    conversationId: session.conversationId,
    leadId,
    orgId: session.orgId,
    userId: session.userId,
    contactName: session.leadName,
    projectName: session.projectName,
    profileId: session.voiceProfileId,
  });
  await persistSeedToVoiceSession(session.conversationId, seed);
  session.contextSeeded = true;
  session.voiceContextSeed = seed;
  logger.info('[voiceContextSeed] seeded before first audio', {
    conversationId: session.conversationId,
    method: seed.method,
    profileId: seed.profileId,
    leadId: seed.leadId,
  });
  return seed;
}

module.exports = {
  buildVoiceSessionSeed,
  persistSeedToVoiceSession,
  seedBeforeFirstAudio,
};
