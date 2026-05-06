const crypto = require('crypto');
const db = require('../config/db');
const env = require('../config/env');
const aiService = require('./ai.service');
const tataVoiceService = require('./tataVoice.service');
const sarvamService = require('./sarvam.service');
const { generatePromotionalVideo } = require('./aiVideo.service');
const { retrieveTopK } = require('./projectKnowledge.service');
const { honorificNameJi } = require('../utils/voiceHonorifics');

const videoQueue = [];
const videoQueueRunning = new Set();
const videoQueueEnqueued = new Set();
const VIDEO_JOB_MAX_CONCURRENCY = Math.max(1, Number(env.ai?.videoJobMaxConcurrency) || 2);

function nowIso() {
  return new Date().toISOString();
}

function newExternalId(prefix) {
  if (typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function mapSessionRow(row, turns) {
  const md = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
  return {
    conversationId: row.conversation_id,
    brandId: row.brand_id,
    leadId: row.lead_id,
    phone: row.contact_phone,
    name: row.contact_name || 'User',
    locale: row.locale,
    state: row.state,
    mode: row.mode,
    turns: turns || [],
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
    orgId: row.org_id,
    userId: row.user_id,
    metadata: md,
    projectId: md.projectId || null,
    agentName: md.agentName || null,
  };
}

function mapTurnRow(t) {
  return {
    role: t.role,
    content: t.content,
    created_at: t.created_at ? new Date(t.created_at).toISOString() : nowIso(),
  };
}

function mapJobRow(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    status: row.status,
    prompt: row.prompt,
    objective: row.objective,
    brandName: row.brand_name,
    websiteUrl: row.website_url,
    locale: row.locale,
    video_url: row.video_url,
    result: row.result,
    error: row.error,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : nowIso(),
    orgId: row.org_id,
    userId: row.user_id,
  };
}

function safeParseJsonObject(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Hot / Warm / Cold from pipeline + score (aligned with Sales UI heuristics). */
function intentTierFromDbLead(row) {
  if (!row) return { tier: 'Warm', label: 'Unknown' };
  const st = String(row.stage || '').toLowerCase();
  if (st === 'proposal' || st === 'closed_won') return { tier: 'Hot', label: 'Pipeline: high intent stage' };
  if (st === 'closed_lost') return { tier: 'Cold', label: 'Pipeline: closed lost' };
  if (st === 'qualified') return { tier: 'Warm', label: 'Pipeline: qualified' };
  if (st === 'contacted') return { tier: 'Warm', label: 'Pipeline: contacted' };
  const score = Number(row.ai_score);
  if (!Number.isNaN(score)) {
    if (score >= 80) return { tier: 'Hot', label: 'AI score band: high' };
    if (score >= 50) return { tier: 'Warm', label: 'AI score band: medium' };
    return { tier: 'Cold', label: 'AI score band: low' };
  }
  if (st === 'new') return { tier: 'Cold', label: 'New lead' };
  return { tier: 'Warm', label: 'Default' };
}

async function fetchLeadCrmContextForVoice({ leadId, orgId: _ignoredOrg }) {
  if (!leadId) return { block: '', intent: null, row: null };
  /** Bind by lead id only — JWT org can disagree with leads.org_id; session must already authorize this lead. */
  const { rows } = await db.query(
    `SELECT contact_first_name, contact_last_name, contact_phone, stage, priority, ai_score, notes, company_name, source, metadata, org_id
     FROM leads WHERE id = $1 LIMIT 1`,
    [leadId]
  );
  const r = rows[0];
  if (!r) return { block: '', intent: null, row: null };
  const intent = intentTierFromDbLead(r);
  const notes = String(r.notes || '').trim().slice(0, 450);
  const meta = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
  const extras = [];
  if (meta.projectName) extras.push(`Project name (metadata): ${meta.projectName}`);
  if (meta.campaignName) extras.push(`Campaign (metadata): ${meta.campaignName}`);
  const name = `${r.contact_first_name || ''} ${r.contact_last_name || ''}`.trim();
  const block = [
    'CRM CONTEXT (same lead as this call):',
    `Contact name on file: ${name || 'Unknown'}`,
    `Phone: ${r.contact_phone || 'N/A'}`,
    `Pipeline stage: ${r.stage || 'unknown'}`,
    `Priority: ${r.priority || 'medium'}`,
    `AI score (0–100): ${typeof r.ai_score === 'number' ? r.ai_score : 'not set'}`,
    `Current intent label (from CRM): ${intent.tier} — ${intent.label}`,
    r.source ? `Lead source: ${r.source}` : null,
    r.company_name ? `Company: ${r.company_name}` : null,
    notes ? `Rep notes: ${notes}` : null,
    extras.length ? extras.join('\n') : null,
  ]
    .filter(Boolean)
    .join('\n');
  return { block, intent, row: r };
}

function normalizePromptKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function allocateExactDurations(totalDurationSec, sceneCount, minPerScene = 5, maxPerScene = 12) {
  const total = Math.max(minPerScene * sceneCount, Math.min(120, Number(totalDurationSec) || 12));
  const arr = new Array(sceneCount).fill(Math.floor(total / sceneCount));
  let rem = total - arr.reduce((a, b) => a + b, 0);

  for (let i = 0; i < arr.length && rem > 0; i++) {
    arr[i] += 1;
    rem -= 1;
  }

  for (let i = 0; i < arr.length; i++) {
    arr[i] = Math.max(minPerScene, Math.min(maxPerScene, arr[i]));
  }

  let diff = total - arr.reduce((a, b) => a + b, 0);
  let guard = 0;
  while (diff !== 0 && guard < 1000) {
    guard += 1;
    for (let i = 0; i < arr.length && diff !== 0; i++) {
      if (diff > 0 && arr[i] < maxPerScene) {
        arr[i] += 1;
        diff -= 1;
      } else if (diff < 0 && arr[i] > minPerScene) {
        arr[i] -= 1;
        diff += 1;
      }
    }
    if (guard > 3 && diff !== 0) break;
  }
  return arr;
}

async function buildVideoScenePlan({
  brandName,
  objective,
  campaignPrompt,
  websiteUrl,
  locale,
  totalDurationSec,
}) {
  // Keep clip generation reliable by splitting into short scenes.
  const boundedTotal = Math.max(10, Math.min(120, Number(totalDurationSec) || 12));
  const sceneCount = Math.max(2, Math.min(12, Math.round(boundedTotal / 10)));
  const perSceneDuration = Math.max(5, Math.min(12, Math.floor(boundedTotal / sceneCount)));
  const planPrompt = [
    'Create a cinematic ad video storyboard as strict JSON only.',
    `Brand: ${brandName}`,
    `Objective: ${objective}`,
    `Campaign brief: ${campaignPrompt}`,
    `Website context: ${websiteUrl || 'N/A'}`,
    `Locale: ${locale || 'en'}`,
    `Total duration target: ${totalDurationSec}s`,
    `Scene count: ${sceneCount}`,
    `Per scene duration: around ${perSceneDuration}s`,
    'Return exactly this JSON shape:',
    '{"headline":"...","tone":"...","scenes":[{"title":"...","prompt":"...","camera":"...","durationSec":8}]}',
    'Rules:',
    '- scenes length must equal requested scene count',
    '- each scene MUST be different from others (no repeated scene concept)',
    '- prompts must describe real motion and visible human activity',
    '- include at least some scenes inside buildings with people moving naturally',
    '- include at least some scenes showing rural life with unique local human actions',
    '- avoid empty property shots with no people',
    '- avoid slideshow/static wording',
    '- keep each scene duration between 5 and 12 seconds',
  ].join('\n');

  const aiText = await aiService.callAI(planPrompt);
  const parsed = safeParseJsonObject(aiText);
  if (!parsed || !Array.isArray(parsed.scenes) || !parsed.scenes.length) {
    const fallbackDurations = allocateExactDurations(boundedTotal, 2);
    return {
      headline: `${brandName} cinematic ad`,
      tone: 'cinematic, realistic, dynamic',
      scenes: [
        {
          title: 'Hero opening',
          camera: 'drone cinematic approach',
          durationSec: fallbackDurations[0],
          prompt: `Cinematic realistic ad for ${brandName}. ${campaignPrompt}. Human presence, natural movement, dynamic camera motion.`,
        },
        {
          title: 'Lifestyle action',
          camera: 'gimbal tracking shot',
          durationSec: fallbackDurations[1],
          prompt: `Lifestyle-focused scene for ${brandName} with people interacting naturally indoors and outdoors, aspirational mood, realistic motion and lighting.`,
        },
      ],
    };
  }

  const cameraVariations = [
    'drone orbit reveal',
    'gimbal tracking push-in',
    'wide cinematic crane movement',
    'ground-level dolly movement',
    'aerial establishing sweep',
    'shoulder-height walk-through',
    'slow parallax lateral glide',
    'dynamic follow shot',
    'sunset panoramic sweep',
    'close-to-wide cinematic pullback',
    'forward motion with depth',
    'curved cinematic arc shot',
  ];
  const seenKeys = new Set();
  const sanitizedScenes = parsed.scenes
    .slice(0, sceneCount)
    .map((s, i) => ({
      title: s?.title || `Scene ${i + 1}`,
      camera: s?.camera || cameraVariations[i % cameraVariations.length],
      durationSec: Math.max(5, Math.min(12, Number(s?.durationSec) || perSceneDuration)),
      prompt: String(
        s?.prompt ||
          `${campaignPrompt}. Realistic motion, natural human activity, people visible in action, cinematic camera movement, no static slideshow look.`
      ).slice(0, 1200),
    }))
    .map((scene, i) => {
      const baseKey = `${normalizePromptKey(scene.title)}|${normalizePromptKey(scene.prompt)}`;
      let key = baseKey;
      let suffix = 0;
      while (seenKeys.has(key)) {
        suffix += 1;
        key = `${baseKey}|${suffix}`;
      }
      seenKeys.add(key);
      if (suffix > 0) {
        scene.prompt = `${scene.prompt}\nUnique scene angle ${i + 1}: emphasize a different location perspective and action sequence from all previous scenes.`;
      }
      return scene;
    });

  while (sanitizedScenes.length < sceneCount) {
    sanitizedScenes.push({
      title: `Scene ${sanitizedScenes.length + 1}`,
      camera: 'cinematic movement',
      durationSec: perSceneDuration,
      prompt: `${campaignPrompt}. Human-centered dynamic commercial scene with realistic motion.`,
    });
  }

  const exactDurations = allocateExactDurations(boundedTotal, sanitizedScenes.length);
  sanitizedScenes.forEach((s, i) => {
    s.durationSec = exactDurations[i];
  });

  return {
    headline: parsed.headline || `${brandName} cinematic ad`,
    tone: parsed.tone || 'cinematic, realistic, dynamic',
    scenes: sanitizedScenes,
  };
}

/**
 * Demo sessions have org_id NULL; org users must only access their org's rows.
 */
function assertVoiceSessionAccess(session, { orgId, userId }) {
  if (!session) {
    const err = new Error('Voice session not found');
    err.statusCode = 404;
    err.code = 'VOICE_SESSION_NOT_FOUND';
    throw err;
  }
  const sessionOrg = session.org_id;
  const sameOrg = orgId && sessionOrg && String(sessionOrg) === String(orgId);
  const anonDemo = !sessionOrg && !orgId;
  const personalNoOrg =
    !sessionOrg && userId && session.user_id && String(session.user_id) === String(userId);

  if (sameOrg) {
    if (userId && session.user_id && String(session.user_id) !== String(userId)) {
      const err = new Error('Voice session not found');
      err.statusCode = 404;
      err.code = 'VOICE_SESSION_NOT_FOUND';
      throw err;
    }
    return;
  }

  if (anonDemo || personalNoOrg) return;

  const err = new Error('Voice session not found');
  err.statusCode = 404;
  err.code = 'VOICE_SESSION_NOT_FOUND';
  throw err;
}

async function loadVoiceSession(conversationId) {
  const { rows } = await db.query(
    `SELECT * FROM ai_voice_sessions WHERE conversation_id = $1`,
    [conversationId]
  );
  return rows[0] || null;
}

async function loadVoiceTurns(conversationId) {
  const { rows } = await db.query(
    `SELECT role, content, created_at FROM ai_voice_turns WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [conversationId]
  );
  return rows.map(mapTurnRow);
}

/** First spoken line when the call connects — matches lead default locale when possible. */
function voiceOpenerForLocale(locale, contactName, voiceGender = 'unknown') {
  const raw = String(contactName || '').trim();
  const first = raw.split(/\s+/)[0] || 'there';
  const ji = honorificNameJi(raw) || `${first} Ji`;
  const l = String(locale || 'hing').toLowerCase();
  const g = String(voiceGender || 'unknown').toLowerCase();
  const englishSalute = g === 'female' ? 'Hello Ms.' : g === 'male' ? 'Hello Mr.' : 'Hello';
  if (l === 'hi' || l === 'hin') {
    return `Namaste ${ji}, main SalesPal AI se baat kar raha hoon. Bataiye, aaj main aapki kaise madad kar sakta hoon?`;
  }
  if (l === 'hing' || l === 'hinglish') {
    return `Namaskar ${ji}! SalesPal AI bol raha hoon — naturally, clearly. Aaj main aapki kaise help kar sakta hoon?`;
  }
  if (l === 'en' || l.startsWith('en-')) {
    return `${englishSalute} ${ji}, this is SalesPal AI — how can I help you today?`;
  }
  return `Hello ${ji}, this is SalesPal AI. How can I help you today?`;
}

async function buildContextualVoiceOpener({ locale, contactName, openerContext, projectBrief, projectName, voiceGender }) {
  const fallback = voiceOpenerForLocale(locale, contactName, voiceGender);
  const context = String(openerContext || '').trim();
  const pb = String(projectBrief || '').trim();
  const pn = String(projectName || '').trim();

  if (!context && !pb && !pn) return fallback;
  try {
    const prompt = [
      'Create one short, natural opening line for a live sales call.',
      `CRM name (respect spelling; politely use full name + Ji when addressing): ${honorificNameJi(String(contactName || '').trim()) || String(contactName || 'there').split(/\s+/)[0]}`,
      `Preferred locale: ${locale || 'hing'}`,
      pn
        ? `This call is primarily to discuss the real-estate / project listing: "${pn}". You MUST name the project in the opener and invite the lead to talk about it (location fit, budget, visit, next step).`
        : 'No specific project was selected; keep the opener generic but helpful.',
      pb ? `Project facts and materials (ground truth for what you may reference — do not invent beyond this):\n${pb.slice(0, 3200)}` : null,
      context ? `Continue from this prior WhatsApp context when relevant:\n${context.slice(0, 1200)}` : null,
      'Rules: 1-2 lines only, spoken style, no bullets, no placeholders, warm and consultative.',
    ]
      .filter(Boolean)
      .join('\n');
    const line = await aiService.callAI(prompt);
    const cleaned = String(line || '').trim().replace(/\s+/g, ' ');
    return cleaned || fallback;
  } catch (_) {
    return fallback;
  }
}

/** Smartflo ignores unknown JSON keys — model may omit the listing name on PSTN anyway; enforce spoken mention. */
function ensureOpenerNamesProjectListing(opener, projectName, locale) {
  const pn = String(projectName || '').trim();
  const base = String(opener || '').trim();
  if (!pn) return base || '';
  const needle = pn.toLowerCase().slice(0, Math.min(pn.length, 48));
  if (needle.length >= 2 && base.toLowerCase().includes(needle)) return base;

  const loc = String(locale || 'hing').toLowerCase().replace(/_/g, '-');
  let glue = '';
  if (loc.startsWith('hi') || loc.startsWith('hing') || /^hi-?in\b/.test(loc)) {
    glue = `Ye call ${pn} project ke baare me hai — batayein aap kya dekh rahe hain?`;
  } else if (/^(mr|ta|te|kn|ml|gu|bn|pa)(-|)/.test(loc)) {
    glue = `I'm reaching out specifically about ${pn}. What would help you decide on the next step?`;
  } else {
    glue = `I'm calling about ${pn} specifically — what's most important for you to know today?`;
  }
  return base ? `${glue} ${base}`.trim() : glue;
}

/**
 * PSTN line sold to the lead: only the selected project (Smartflo portal bot often ignores extras;
 * this text is also embedded in `custom_identifier` for Voice Bot streaming integrations).
 */
function buildStrictTelephonyProjectOpener({ locale, contactName, projectName, projectBrief, agentName }) {
  const pn = String(projectName || '').trim();
  const raw = String(contactName || '').trim();
  const first = raw.split(/\s+/)[0] || 'there';
  const ji = honorificNameJi(raw) || `${first} Ji`;
  const agent = String(agentName || 'SalesPal AI').trim().slice(0, 40);
  const loc = String(locale || 'hing').toLowerCase().replace(/_/g, '-');

  let fact = '';
  const pb = String(projectBrief || '').trim();
  if (pb) {
    const chunk = pb.split(/(?<=[.!?])\s+/)[0] || pb.split('\n')[0] || pb;
    fact = String(chunk).trim().replace(/\s+/g, ' ').slice(0, 130);
  }

  if (!pn) {
    if (loc.startsWith('hi') || loc.startsWith('hing') || /^hi-?in\b/.test(loc)) {
      return `Namaskar ${ji}, main ${agent} bol raha hoon. Is call ka purpose real-estate listing discuss karna hai — kripya SalesPal me project select karke dubara call lagayein.`;
    }
    return `Hello ${ji}, this is ${agent}. This automated line is meant to discuss one specific project your team selects in SalesPal.`;
  }

  if (loc.startsWith('hi') || loc.startsWith('hing') || /^hi-?in\b/.test(loc)) {
    const tail = fact ? ` ${fact}` : '';
    return `Namaskar ${ji}, main ${agent} bol raha hoon. Ye call sirf ${pn} project ke liye hai — iske alawa koi aur topic nahi.${tail} Aapko location pasand hai ya pehle budget discuss karna hai?`;
  }
  if (/^(mr|ta|te|kn|ml|gu|bn|pa)(-|)/.test(loc)) {
    const tail = fact ? ` ${fact}` : '';
    return `Hello ${ji}, ${agent} here. I'm calling only about the ${pn} listing — nothing else on this line.${tail} Should we start with location, pricing, or a site visit?`;
  }
  const tail = fact ? ` ${fact}` : '';
  return `Hello ${ji}, this is ${agent}. This call is only about ${pn}.${tail} What would you like to know first — location, pricing, or timeline?`;
}

function normalizeAgentName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'SalesPal AI';
  return raw.slice(0, 40);
}

function isProjectFactQuestion(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /(project|property|plot|site|location|address|price|pricing|rate|cost|acre|sq ?ft|inventory|availability|amenities|rera|legal|possession|payment plan|booking)/i.test(
    t
  );
}

async function fetchProjectKnowledgeContext({ projectId, queryText, leadId, userId }) {
  const access = await resolveBrainDriveOrgForVoice({
    projectId,
    leadId: leadId || null,
    userId: userId || null,
  });
  const kbOrgId = access?.knowledgeOrgId;
  if (!kbOrgId || !projectId) return [];
  const { rows } = await db.query(
    `SELECT source_type, source_name, content, embedding
     FROM project_knowledge
     WHERE org_id = $1 AND project_id = $2`,
    [kbOrgId, projectId]
  );
  if (!rows.length) return [];
  const q = String(queryText || '').trim() || 'project overview';
  return retrieveTopK(q, rows, 8);
}

async function fetchProjectRecordForVoice({ orgId, projectId }) {
  if (!orgId || !projectId) return null;
  const { rows } = await db.query(
    `SELECT id, name, description, industry, metadata
     FROM projects
     WHERE id = $1 AND org_id = $2
     LIMIT 1`,
    [projectId, orgId]
  );
  return rows[0] || null;
}

/** Load listing row by id only (canonical org lives on projects.org_id — Brain Drive keys match that). */
async function fetchProjectRecordById(projectId) {
  if (!projectId) return null;
  const { rows } = await db.query(
    `SELECT id, org_id, name, description, industry, metadata
     FROM projects
     WHERE id = $1
     LIMIT 1`,
    [projectId]
  );
  return rows[0] || null;
}

async function fetchAllProjectKnowledgeRows({ orgId, projectId }) {
  if (!orgId || !projectId) return [];
  const { rows } = await db.query(
    `SELECT source_type, source_name, content, embedding
     FROM project_knowledge
     WHERE org_id = $1 AND project_id = $2`,
    [orgId, projectId]
  );
  return rows;
}

/**
 * Brain Drive rows are keyed by projects.org_id. Reps/leads sometimes resolve a different org_id.
 * Resolve the project's canonical org after a lightweight access check vs the lead tag.
 */
async function resolveBrainDriveOrgForVoice({ projectId, leadId, userId }) {
  if (!projectId) return null;
  const project = await fetchProjectRecordById(projectId);
  if (!project?.org_id) return null;

  if (!leadId) {
    return { knowledgeOrgId: project.org_id, project };
  }

  const { rows: lrows } = await db.query(
    `SELECT id, org_id, user_id, metadata FROM leads WHERE id = $1 LIMIT 1`,
    [leadId]
  );
  const lead = lrows[0];
  if (!lead) return null;

  const meta = lead.metadata && typeof lead.metadata === 'object' ? lead.metadata : {};
  const tagged =
    Boolean(meta.projectId && String(meta.projectId) === String(projectId)) ||
    Boolean(meta.project_id && String(meta.project_id) === String(projectId));

  const leadOrg = lead.org_id || null;
  const projOrg = project.org_id;
  const sameOrg =
    leadOrg === null ||
    projOrg === null ||
    String(leadOrg) === String(projOrg);

  const callerOwnsLead =
    userId &&
    lead.user_id != null &&
    String(lead.user_id) === String(userId);

  if (!(sameOrg || tagged || callerOwnsLead)) {
    console.warn('[aiRuntime] Brain Drive org gate: lead/project mismatch', {
      leadId,
      projectId,
    });
    return null;
  }

  return { knowledgeOrgId: project.org_id, project };
}

/** Rich baseline used for opener + persisted on session for consistent project-centric discussion */
async function buildVoiceProjectDiscussionBrief({ orgId: _fallbackOrgId, projectId, leadId, userId }) {
  const access = await resolveBrainDriveOrgForVoice({
    projectId,
    leadId: leadId || null,
    userId: userId || null,
  });
  if (!access?.knowledgeOrgId || !access.project) {
    return {
      brief: '',
      displayName: null,
      hasKnowledge: false,
    };
  }

  const { knowledgeOrgId, project } = access;

  const pname = String(project.name || '').trim() || 'this project';
  const desc = String(project.description || '').trim().slice(0, 900);
  const industry = project.industry ? String(project.industry).trim() : '';
  let lines = [`Name: "${pname}"`];
  if (industry) lines.push(`Category / industry hint: ${industry}`);
  if (desc) lines.push(`Recorded description:\n${desc}`);

  const knowledgeRows = await fetchAllProjectKnowledgeRows({ orgId: knowledgeOrgId, projectId });
  if (!knowledgeRows.length) {
    return {
      brief: lines.join('\n'),
      displayName: pname,
      hasKnowledge: false,
    };
  }

  const seedQueries = [
    `${pname} overview introduction marketing pitch`,
    `${pname} pricing payment plan EMI booking possession`,
    `${pname} location connectivity amenities RERA legal inventory`,
    `site visit brochure floor plan plots units`,
  ];
  const chunks = [];
  const seen = new Set();
  for (const qs of seedQueries) {
    for (const r of retrieveTopK(qs, knowledgeRows, 5)) {
      const key = `${r.source_name || ''}:${String(r.content || '').slice(0, 140)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push(r);
      if (chunks.length >= 16) break;
    }
    if (chunks.length >= 16) break;
  }

  const materialLines = chunks.map((r) => `[${r.source_type}] ${String(r.source_name || 'source')}: ${r.content}`);
  lines.push('');
  lines.push('Brain Drive / indexed materials (excerpts):');
  lines.push(materialLines.join('\n---\n'));

  return {
    brief: lines.join('\n').slice(0, 6200),
    displayName: pname,
    hasKnowledge: chunks.length > 0,
  };
}

function resolveVoiceTtsForClient() {
  const want = String(env.integrations?.voiceTtsProvider || 'auto').trim().toLowerCase();
  const sarvamOk = sarvamService.isSarvamTtsConfigured(env);
  const enforceOnly = want === 'sarvam';
  /** auto (default): use Sarvam whenever API key is set; explicit browser skips Sarvam. */
  let provider = 'browser';
  if (want === 'browser') {
    provider = 'browser';
  } else if (sarvamOk && (want === 'auto' || want === '' || want === 'sarvam')) {
    provider = 'sarvam';
  }
  return {
    provider,
    sarvam_configured: sarvamOk,
    requested_provider: want,
    enforce_only: enforceOnly,
    unavailable_reason:
      enforceOnly && !sarvamOk
        ? 'Sarvam TTS is required but SARVAM_API_SUBSCRIPTION_KEY is missing.'
        : null,
    mime_type_hint: provider === 'sarvam' ? 'audio/wav' : null,
  };
}

/** STT: Sarvam REST when key + auto/sarvam; else browser Web Speech API. */
function resolveVoiceSttForClient() {
  const want = String(env.integrations?.voiceSttProvider || 'auto').trim().toLowerCase();
  const sarvamOk = sarvamService.isSarvamTtsConfigured(env);
  let provider = 'browser';
  if (want === 'browser') {
    provider = 'browser';
  } else if (sarvamOk && (want === 'auto' || want === '' || want === 'sarvam')) {
    provider = 'sarvam';
  }
  return {
    provider,
    sarvam_configured: sarvamOk,
    requested_provider: want,
  };
}

async function createVoiceSession({
  brandId,
  leadId,
  phone,
  name,
  locale,
  mode,
  openerContext,
  projectId,
  agentName,
  voiceGender,
  orgId,
  userId,
}) {
  const conversationId = newExternalId('vs');
  const contactName = name || 'User';
  const safeAgentName = normalizeAgentName(agentName);
  let voiceProjectBrief = '';
  let voiceProjectName = null;
  let voiceProjectHasKnowledge = false;
  if (projectId) {
    try {
      const vp = await buildVoiceProjectDiscussionBrief({
        orgId,
        projectId,
        leadId: leadId || null,
        userId: userId || null,
      });
      voiceProjectBrief = String(vp.brief || '').trim();
      voiceProjectName = vp.displayName || null;
      voiceProjectHasKnowledge = Boolean(vp.hasKnowledge);
    } catch (e) {
      console.warn('[aiRuntime] Voice project brief skipped:', e.message);
    }
  }
  const metadata = {
    projectId: projectId || null,
    agentName: safeAgentName,
    voiceProjectBrief,
    voiceProjectName,
    voiceProjectHasKnowledge,
    humanTakeoverActive: false,
    voiceGender: String(voiceGender || 'unknown').toLowerCase(),
  };
  let mergedOpenerContext = String(openerContext || '').trim();
  if (leadId) {
    try {
      const { block } = await fetchLeadCrmContextForVoice({ leadId, orgId });
      if (block) {
        mergedOpenerContext = mergedOpenerContext ? `${mergedOpenerContext}\n\n${block}` : block;
      }
    } catch (e) {
      console.warn('[aiRuntime] CRM context for voice opener skipped:', e.message);
    }
  }

  const willDialPstn = Boolean(phone && tataVoiceService.isTelephonyEnabled());

  let opener;
  if (willDialPstn) {
    if (voiceProjectName) {
      opener = buildStrictTelephonyProjectOpener({
        locale: locale || 'hing',
        contactName,
        projectName: voiceProjectName,
        projectBrief: voiceProjectBrief,
        agentName: safeAgentName,
      });
    } else if (projectId) {
      console.warn('[aiRuntime] PSTN dial missing display project name — using fallback opener wording.');
      opener = buildStrictTelephonyProjectOpener({
        locale: locale || 'hing',
        contactName,
        projectName: 'your selected CRM project',
        projectBrief: voiceProjectBrief,
        agentName: safeAgentName,
      });
    } else {
      opener = await buildContextualVoiceOpener({
        locale: locale || 'hing',
        contactName,
        openerContext: mergedOpenerContext,
        projectBrief: voiceProjectBrief,
        projectName: voiceProjectName,
        voiceGender: metadata.voiceGender,
      });
      if (voiceProjectName) {
        opener = ensureOpenerNamesProjectListing(opener, voiceProjectName, locale || 'hing');
      }
    }
  } else {
    opener = await buildContextualVoiceOpener({
      locale: locale || 'hing',
      contactName,
      openerContext: mergedOpenerContext,
      projectBrief: voiceProjectBrief,
      projectName: voiceProjectName,
      voiceGender: metadata.voiceGender,
    });
    if (voiceProjectName) {
      opener = ensureOpenerNamesProjectListing(opener, voiceProjectName, locale || 'hing');
    }
  }

  await db.query(
    `INSERT INTO ai_voice_sessions (
      conversation_id, org_id, user_id, brand_id, lead_id, contact_phone, contact_name, locale, state, mode, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'live', $9, $10::jsonb)`,
    [
      conversationId,
      orgId || null,
      userId || null,
      brandId || 'web-demo',
      leadId || null,
      phone || null,
      contactName,
      locale || 'hing',
      mode || null,
      JSON.stringify(metadata),
    ]
  );

  await db.query(
    `INSERT INTO ai_voice_turns (conversation_id, role, content) VALUES ($1, 'assistant', $2)`,
    [conversationId, opener]
  );

  const sessionRow = await loadVoiceSession(conversationId);
  const turns = await loadVoiceTurns(conversationId);
  let telephony = {
    enabled: false,
    provider: 'tata',
    accepted: false,
    reason: 'Telephony provider is disabled',
  };

  if (phone && tataVoiceService.isTelephonyEnabled()) {
    telephony = await tataVoiceService.placeOutboundCall({
      to: phone,
      leadName: contactName,
      conversationId,
      opener,
      projectName: voiceProjectName || null,
      projectId: projectId || null,
      locale: locale || 'hing',
    });
    const style = typeof telephony.apiStyle === 'string' ? telephony.apiStyle : tataVoiceService.resolveApiStyle();
    if (telephony.accepted && style === 'legacy') {
      telephony.integration_notice =
        'Handset playback is controlled by Smartflo’s legacy click-to-call leg; it does not read SalesPal’s opener. Migrate to Smartflo Voice Bot + /v1/click_to_call_support (backend .env.example) for listing-specific PSTN dialogue.';
    }
  }

  return {
    session: mapSessionRow(sessionRow, turns),
    opener,
    telephony,
    voice_tts: resolveVoiceTtsForClient(),
    voice_stt: resolveVoiceSttForClient(),
  };
}

async function handleVoiceTurn({ conversationId, text, orgId, userId }) {
  const row = await loadVoiceSession(conversationId);
  assertVoiceSessionAccess(row, { orgId, userId });
  const mdEarly = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
  if (Boolean(mdEarly.humanTakeoverActive)) {
    const sessionRow = await loadVoiceSession(conversationId);
    const turns = await loadVoiceTurns(conversationId);
    return {
      session: mapSessionRow(sessionRow, turns),
      reply: 'Human agent mode is active for this conversation, so AI responses are paused.',
      factSource: {
        type: 'human_takeover',
        label: 'Human takeover active',
        projectId: mdEarly.projectId || null,
        evidenceCount: 0,
      },
      aiSuppressed: true,
    };
  }

  await db.query(`INSERT INTO ai_voice_turns (conversation_id, role, content) VALUES ($1, 'user', $2)`, [
    conversationId,
    text,
  ]);

  const turnsForChat = await loadVoiceTurns(conversationId);
  const chatMessages = [];
  for (const t of turnsForChat) {
    if (t.role === 'user' || t.role === 'assistant') {
      const c = String(t.content || '').trim();
      if (c) chatMessages.push({ role: t.role, content: c.slice(0, 4000) });
    }
  }

  const leadFirst = String(row.contact_name || 'User').trim().split(/\s+/)[0] || 'there';
  const honorificLead = honorificNameJi(String(row.contact_name || '').trim()) || `${leadFirst} Ji`;
  const sessionLocale = row.locale || 'hing';
  const md = row && typeof row.metadata === 'object' && row.metadata ? row.metadata : {};
  const projectId = md.projectId || null;
  const voicePersona = String(md.voicePersona || '').trim().toLowerCase();
  const voiceGender = String(md.voiceGender || 'unknown').trim().toLowerCase();
  let voiceProjectBrief = String(md.voiceProjectBrief || '').trim();
  let voiceProjectName = String(md.voiceProjectName || '').trim();
  const agentName = normalizeAgentName(md.agentName || 'SalesPal AI');

  const effectiveOrgForProject = row.org_id || orgId;
  const hydrateFailed = Boolean(md.voiceProjectHydrateFailed);
  const thinVoiceBrain =
    !String(voiceProjectName || '').trim() || !String(voiceProjectBrief || '').trim();

  if (projectId && row.lead_id && userId && !hydrateFailed && thinVoiceBrain) {
    try {
      const vp = await buildVoiceProjectDiscussionBrief({
        orgId: effectiveOrgForProject,
        projectId,
        leadId: row.lead_id,
        userId,
      });
      if (vp.displayName || vp.brief) {
        voiceProjectBrief = String(vp.brief || '').trim();
        voiceProjectName = String(vp.displayName || '').trim();
        await mergeVoiceSessionMetadata(
          conversationId,
          {
            voiceProjectBrief,
            voiceProjectName,
            voiceProjectHasKnowledge: Boolean(vp.hasKnowledge),
            voiceProjectHydrateFailed: false,
          },
          { orgId, userId }
        );
      } else {
        await mergeVoiceSessionMetadata(
          conversationId,
          { voiceProjectHydrateFailed: true },
          { orgId, userId }
        );
      }
    } catch (e) {
      console.warn('[aiRuntime] Voice project sticky refresh skipped:', e.message);
      await mergeVoiceSessionMetadata(
        conversationId,
        { voiceProjectHydrateFailed: true },
        { orgId, userId }
      ).catch(() => {});
    }
  }

  let crmBlock = '';
  let crmIntentTier = 'Warm';
  if (row.lead_id && (row.org_id || orgId)) {
    try {
      const crm = await fetchLeadCrmContextForVoice({ leadId: row.lead_id, orgId: row.org_id || orgId });
      crmBlock = crm.block ? `${crm.block}\n` : '';
      if (crm.intent?.tier) crmIntentTier = crm.intent.tier;
    } catch (e) {
      console.warn('[aiRuntime] CRM context for voice turn skipped:', e.message);
    }
  }

  const topKnowledge = await fetchProjectKnowledgeContext({
    projectId,
    queryText: text,
    leadId: row.lead_id || null,
    userId,
  });
  const asksProjectFacts = isProjectFactQuestion(text);

  const pivotWhenProject = projectId
    ? '\n- **Project-first call:** This session has a selected listing. Keep the dialogue centered on it: fit for the lead, clarifying questions, site visit, brochure, next step. For off-topic or purely general questions, answer very briefly in spoken style, then steer back to the project in the same reply.\n- Do not invent project facts; use KNOWLEDGE BOUNDARY + baseline below.'
    : '';

  const boundaryWhenHasRows = topKnowledge.length
    ? `\nPROJECT KNOWLEDGE BOUNDARY (PRIMARY FACT SOURCE):\n${topKnowledge
        .map((r) => `[${r.source_type}] ${r.content}`)
        .join('\n---\n')}\nRules:\n- Use this boundary for project-specific facts (location, pricing, inventory, amenities, legal/process).${pivotWhenProject}\n- Never present general knowledge as project-confirmed fact unless it exists in this boundary.`
    : '';

  const boundaryEmptyRules = projectId
    ? `\nPROJECT KNOWLEDGE BOUNDARY: none loaded for this turn.\nRules:\n- For project-specific facts, say the detail is not in the indexed materials yet — offer a human follow-up or site visit.${pivotWhenProject}\n- Brief general answers are ok if the lead insists, but pivot to the listing.`
    : `\nPROJECT KNOWLEDGE BOUNDARY: none loaded for this call.\nRules:\n- For project-specific facts, say the detail is not currently available in this project data.\n- For non-project/general questions, you may answer using out-of-box AI knowledge.`;

  const projectBoundary =
    topKnowledge.length > 0 ? boundaryWhenHasRows : boundaryEmptyRules;

  const projectDiscussionSticky =
    projectId && (voiceProjectBrief || voiceProjectName)
      ? `\nSELECTED PROJECT CONTEXT (session — stay focused here):\n${voiceProjectName ? `- Name: "${voiceProjectName}"\n` : ''}${
          voiceProjectBrief
            ? `- Baseline snapshot (grounding; summarize in speech — do not dump; do not invent beyond this + KNOWLEDGE BOUNDARY):\n${voiceProjectBrief.slice(0, 6200)}\n`
            : `- Use the KNOWLEDGE BOUNDARY and transcript to discuss this listing.\n`
        }`
      : '';

  const personaSupervisorBlock =
    voicePersona === 'senior_male_ai_supervisor'
      ? `ROLE — SENIOR AI SUPERVISOR (Male executive voice profile):\n- You have taken over from the front-line bot. Tone: calm, decisive, respectful authority — never rude.\n- Still mirror exactly the languages / scripts used in the lead's **last utterance**, including Hindi, Tamil, Telugu, Marathi, Bengali, Gujarati, Kannada, Malayalam, Urdu/Punjabi, Arabic, English — and natural Hinglish / code-switching.\n- De-escalate complex objections; summarise trade-offs crisply.\n- Offer an **organic human manager** ONLY if they clearly insist twice that they will not continue with AI.\n\n`
      : '';

  const listingLabel = voiceProjectName || (projectId ? `project ${projectId}` : '');
  const projectMandatoryBlock = projectId
    ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nPRIMARY SUBJECT (NON-NEGOTIABLE)\n- This Tata / SalesPal voice session exists ONLY to sell and qualify interest in: **"${listingLabel}"**.\n- You MUST name this listing explicitly when it helps clarity and keep substance tied to location fit, pricing band, timelines, inventory, amenities, paperwork, visit — for THIS listing only.\n- Do **not** treat this as a generic customer-service call.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
    : '';

  const voiceSystem = `You are on a live phone-style sales call with a lead (SalesPal).

${projectMandatoryBlock}${crmBlock}${personaSupervisorBlock}
INTENT & CLASSIFICATION:
- CRM currently labels this lead as **${crmIntentTier}** (Hot / Warm / Cold). Use the live conversation to validate or adjust mentally.
- When the conversation is winding down or the lead says goodbye, include **one clear spoken sentence** that states your assessment, e.g. "Based on our chat I would mark you as a warm lead today because …" (use Hot/Warm/Cold and a real reason — no jargon about "CRM").
- Do not repeat the classification every turn; integrate it naturally once when closing or when they ask how serious they are.

IDENTITY:
- Your name is "${agentName}" for this call.
- Never claim another bot/persona name.
- Preferred greeting personalization hint: lead voice profile is "${voiceGender}". Use only if it improves politeness naturally.

LANGUAGE — HIGHEST PRIORITY (Regional fluency + global):
- Respond in exactly the languages / dialects / scripts of the **last user utterance** — including simultaneous code-switch (e.g. Hinglish: English nouns + Hindi grammar). Mirror blend, slang, fillers, rhythm.
- **India:** Fluent mode for Hindi, Marathi, Tamil, Telugu, Bengali, Kannada, Malayalam, Gujarati, Punjabi mixes, Urdu-English — never force pure English unless the lead used English only that turn.
- **Middle East / international:** If Arabic or Arabic-English mix appears, mirror it; UAE-style English is fine when they use it exclusively.
- **Only rule:** Reply language = **last user utterance** only. Earlier assistant lines may differ — ignore their language choices.
- Session default (${sessionLocale}) applies only when the utterance is unintelligible noise.

ADDRESSING PROTOCOL (Indian etiquette — “Ji” engine):
- When politely addressing by name (especially Hindi / Indian English), use CRM spelling exactly: **"${honorificLead}"** — pronounce respectfully—do not caricature or Anglicise unnecessarily.
- In casual rapport you may shorten, but defaults should lean courteous on first address each arc.

Sound human: natural spoken wording, short reactions when they fit ("sure", "got it"), varied rhythm — not robotic or like a document. No bullet lists unless listing two clear options.

Rules:
- Use the full transcript; remember what was already said and stay consistent.
- Reply with ONE short spoken reply (2–4 lines max) only to the lead's last utterance, in context.
- Do not dump unrelated topics, long scripts, or repeated greetings.
- Never use placeholders like [Your Name]. Address the lead as above (honorific Ji when using full polite name).

${aiService.SALES_CONVERSATION_FUNNEL_BLOCK}
${projectDiscussionSticky}
${projectBoundary}`;

  const reply = await aiService.callAIWithMessages(chatMessages, voiceSystem, { temperature: 0.6 });

  await db.query(`INSERT INTO ai_voice_turns (conversation_id, role, content) VALUES ($1, 'assistant', $2)`, [
    conversationId,
    reply,
  ]);

  await db.query(`UPDATE ai_voice_sessions SET updated_at = NOW() WHERE conversation_id = $1`, [conversationId]);

  const sessionRow = await loadVoiceSession(conversationId);
  const turns = await loadVoiceTurns(conversationId);
  const factSource = asksProjectFacts
    ? topKnowledge.length
      ? {
          type: 'project_knowledge',
          label: 'Project Knowledge',
          projectId,
          evidenceCount: topKnowledge.length,
        }
      : {
          type: 'project_data_unavailable',
          label: 'Project Data Unavailable',
          projectId: projectId || null,
          evidenceCount: 0,
        }
    : {
        type: 'general_knowledge',
        label: 'General AI Knowledge',
        projectId: projectId || null,
        evidenceCount: 0,
      };
  return { session: mapSessionRow(sessionRow, turns), reply, factSource };
}

async function mergeVoiceSessionMetadata(conversationId, patch, { orgId, userId } = {}) {
  if (!patch || typeof patch !== 'object') return;
  const row = await loadVoiceSession(conversationId);
  assertVoiceSessionAccess(row, { orgId, userId });
  await db.query(
    `UPDATE ai_voice_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE conversation_id = $1`,
    [conversationId, JSON.stringify(patch)]
  );
}

async function getVoiceTranscriptBrief(conversationId, { orgId, userId } = {}, maxLen = 4000) {
  const row = await loadVoiceSession(conversationId);
  assertVoiceSessionAccess(row, { orgId, userId });
  const turns = await loadVoiceTurns(conversationId);
  const txt = turns.map((x) => `${x.role}: ${x.content}`).join('\n').trim();
  return txt.length <= maxLen ? txt : txt.slice(Math.max(0, txt.length - maxLen));
}

async function getVoiceHistory(conversationId, { orgId, userId } = {}) {
  const row = await loadVoiceSession(conversationId);
  assertVoiceSessionAccess(row, { orgId, userId });
  const turns = await loadVoiceTurns(conversationId);
  return mapSessionRow(row, turns);
}

async function summarizeVoiceSession(conversationId, { orgId, userId } = {}) {
  const row = await loadVoiceSession(conversationId);
  assertVoiceSessionAccess(row, { orgId, userId });

  const turns = await loadVoiceTurns(conversationId);
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  const system = `You summarize B2C/B2B phone qualification calls for SalesPal.
Return STRICT JSON only (no markdown) with keys:
- summary (string, 2–4 sentences)
- sentiment (one of: very_positive, positive, neutral, negative, very_negative)
- outcome (short phrase, e.g. "Interested — site visit pending")
- next_action (one concrete next step for the human rep)
- suggested_intent_tier (exactly one of: Hot, Warm, Cold) — Hot = strong buying intent or meeting/deposit discussed; Warm = interest but needs follow-up; Cold = not interested or no fit
- intent_rationale (one sentence explaining suggested_intent_tier)
- suggested_ai_score (integer 0–100 aligned with suggested_intent_tier)`;

  const userContent = `Call transcript:\n${transcript}`;

  const fallbackJson = {
    summary: 'Summary unavailable.',
    sentiment: 'neutral',
    outcome: 'Unknown',
    next_action: 'Review transcript manually.',
    suggested_intent_tier: 'Warm',
    intent_rationale: 'Automatic summary failed.',
    suggested_ai_score: 50,
  };

  let summaryText = '';
  let summaryJson = null;
  try {
    const raw = await aiService.callAIWithMessages([{ role: 'user', content: userContent }], system, {
      temperature: 0.25,
      maxTokens: 1200,
      responseFormat: 'json_object',
    });
    summaryText = String(raw || '').trim();
    summaryJson = safeParseJsonObject(summaryText);
    if (!summaryJson) {
      summaryJson = { ...fallbackJson, summary: summaryText.slice(0, 800) || fallbackJson.summary };
      summaryText = JSON.stringify(summaryJson);
    }
  } catch (e) {
    console.error('[aiRuntime] summarizeVoiceSession AI error:', e.message);
    summaryJson = { ...fallbackJson };
    summaryText = JSON.stringify(summaryJson);
  }

  await db.query(`UPDATE ai_voice_sessions SET state = 'complete', updated_at = NOW() WHERE conversation_id = $1`, [
    conversationId,
  ]);

  const sessionRow = await loadVoiceSession(conversationId);
  const updatedTurns = await loadVoiceTurns(conversationId);
  return { session: mapSessionRow(sessionRow, updatedTurns), summary: summaryText, summaryJson };
}

async function createVideoJob({
  prompt,
  objective,
  brandName,
  websiteUrl,
  locale,
  durationSec,
  aspectRatio,
  referenceImageUrl,
  orgId,
  userId,
}) {
  const normalizedPrompt = String(prompt || 'Promotional brand video').trim().slice(0, 2000);
  const normalizedObjective = String(objective || 'Awareness').trim().slice(0, 200);
  const normalizedBrandName = String(brandName || 'SalesPal').trim().slice(0, 200);
  const normalizedWebsiteUrl = websiteUrl ? String(websiteUrl).trim().slice(0, 1000) : null;
  const normalizedLocale = String(locale || 'en').trim().slice(0, 40) || 'en';

  // De-duplicate active jobs so repeated frontend retries do not spawn many
  // long-running Veo polls that can exhaust backend memory.
  const { rows: activeRows } = await db.query(
    `SELECT *
     FROM ai_video_jobs
     WHERE org_id = $1
       AND COALESCE(user_id::text, '') = COALESCE($2::text, '')
       AND status IN ('queued', 'running')
       AND prompt = $3
       AND objective = $4
       AND brand_name = $5
       AND COALESCE(website_url, '') = COALESCE($6, '')
       AND locale = $7
       AND created_at >= NOW() - INTERVAL '30 minutes'
     ORDER BY created_at DESC
     LIMIT 1`,
    [orgId, userId || null, normalizedPrompt, normalizedObjective, normalizedBrandName, normalizedWebsiteUrl, normalizedLocale]
  );
  if (activeRows[0]) {
    return mapJobRow(activeRows[0]);
  }

  const jobId = newExternalId('vj');
  const { rows } = await db.query(
    `INSERT INTO ai_video_jobs (
      job_id, org_id, user_id, status, prompt, objective, brand_name, website_url, locale
    ) VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
    RETURNING *`,
    [
      jobId,
      orgId,
      userId || null,
      normalizedPrompt,
      normalizedObjective,
      normalizedBrandName,
      normalizedWebsiteUrl,
      normalizedLocale,
    ]
  );
  return mapJobRow(rows[0]);
}

async function runVideoJob(jobId, { orgId, durationSec = 12, aspectRatio = '9:16', referenceImageUrl = '' } = {}) {
  const { rows: found } = await db.query(`SELECT * FROM ai_video_jobs WHERE job_id = $1`, [jobId]);
  const existing = found[0];
  if (!existing) return;
  if (orgId && existing.org_id !== orgId) return;
  if (existing.status === 'running' || existing.status === 'completed') return;

  const { rowCount } = await db.query(
    `UPDATE ai_video_jobs
     SET status = 'running', updated_at = NOW()
     WHERE job_id = $1
       AND status = 'queued'`,
    [jobId]
  );
  if (!rowCount) return;

  try {
    const jobRes = await db.query(`SELECT * FROM ai_video_jobs WHERE job_id = $1`, [jobId]);
    const job = jobRes.rows[0];
    const requestedDuration = Math.round(Number(durationSec) || 8);
    const singlePrompt = [
      String(job.prompt || '').trim(),
      `Brand: ${job.brand_name || 'SalesPal'}`,
      `Objective: ${job.objective || 'Awareness'}`,
      `Website context: ${job.website_url || 'N/A'}`,
      `Locale: ${job.locale || 'en'}`,
      'Requirement: lifelike moving people, realistic environmental motion, no static framing.',
      'Requirement: show humans clearly (walking, interacting, working, touring spaces).',
      'Requirement: include both interior building activity and rural lifestyle cues.',
      `Target duration must be exactly ${requestedDuration} seconds.`,
    ]
      .filter(Boolean)
      .join('\n');

    const generated = await generatePromotionalVideo({
      prompt: singlePrompt,
      durationSec: requestedDuration,
      aspectRatio,
      imageUrl: referenceImageUrl || '',
    });

    const videoUrl = generated.videoUrl || null;
    if (!videoUrl) {
      throw new Error('No video URL was generated');
    }
    const rawMeta = generated.raw && typeof generated.raw === 'object' ? generated.raw : {};
    const stitched = rawMeta.stitched === true;
    const result = {
      provider: generated.provider || 'unknown',
      durationSec: requestedDuration,
      ...(stitched && rawMeta.plannedTotalSeconds != null
        ? { plannedTotalSeconds: rawMeta.plannedTotalSeconds }
        : {}),
      ...(stitched && Array.isArray(rawMeta.segmentDurationsSeconds)
        ? { segmentDurationsSeconds: rawMeta.segmentDurationsSeconds }
        : {}),
      aspectRatio,
      referenceImageUrl: referenceImageUrl || null,
      mode: stitched ? 'veo-stitched' : 'single-clip-exact-duration',
    };

    await db.query(
      `UPDATE ai_video_jobs SET status = 'completed', video_url = $2, result = $3::jsonb, error = NULL, updated_at = NOW() WHERE job_id = $1`,
      [jobId, videoUrl, JSON.stringify(result)]
    );
  } catch (err) {
    await db.query(
      `UPDATE ai_video_jobs SET status = 'failed', error = $2, updated_at = NOW() WHERE job_id = $1`,
      [jobId, err.message || 'Video generation failed']
    );
  }
}

function pumpVideoQueue() {
  while (videoQueueRunning.size < VIDEO_JOB_MAX_CONCURRENCY && videoQueue.length > 0) {
    const next = videoQueue.shift();
    if (!next || !next.jobId) continue;
    const { jobId } = next;
    videoQueueEnqueued.delete(jobId);
    if (videoQueueRunning.has(jobId)) continue;
    videoQueueRunning.add(jobId);
    runVideoJob(jobId, next.options || {})
      .catch((err) => {
        console.error('[aiRuntime] queued video job failed:', jobId, err?.message || err);
      })
      .finally(() => {
        videoQueueRunning.delete(jobId);
        setImmediate(pumpVideoQueue);
      });
  }
}

function enqueueVideoJob(jobId, options = {}) {
  if (!jobId) return;
  if (videoQueueRunning.has(jobId) || videoQueueEnqueued.has(jobId)) return;
  videoQueue.push({ jobId, options });
  videoQueueEnqueued.add(jobId);
  setImmediate(pumpVideoQueue);
}

async function getVideoJob(jobId, { orgId } = {}) {
  const { rows } = await db.query(`SELECT * FROM ai_video_jobs WHERE job_id = $1`, [jobId]);
  const row = rows[0];
  if (!row) return null;
  if (orgId && row.org_id !== orgId) return null;
  return mapJobRow(row);
}

module.exports = {
  createVoiceSession,
  handleVoiceTurn,
  mergeVoiceSessionMetadata,
  getVoiceTranscriptBrief,
  getVoiceHistory,
  summarizeVoiceSession,
  createVideoJob,
  runVideoJob,
  enqueueVideoJob,
  getVideoJob,
};
