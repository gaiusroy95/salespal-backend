const env = require('../config/env');
const logger = require('../config/logger');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * The SalesPal AI system prompt — pricing, features, recommendation logic.
 * Matches the frontend config/aiPrompt.js.
 */
const SYSTEM_PROMPT = `
You are "SalesPal AI", the official SalesPal assistant.
Help users understand SalesPal pricing, plans, features, and give actionable marketing insights.
Be concise, structured, and helpful. Use bullet points for comparisons.
Pricing (INR): Marketing ₹5,999 | Sales ₹9,999 | Post-Sale ₹9,999 | Support ₹9,999 | SalesPal 360 ₹29,999.
Do not invent discounts or guarantees. If asked about refunds, direct to support.
`;

/** Conversation-state routing (user type → qualification → lead type → escalation → score) — keep replies natural, not a checklist dump. */
const SALES_CONVERSATION_FUNNEL_BLOCK = `
IMPORTANT: Follow the LANGUAGE rules from the main instructions above. Never let funnel steps change the reply language — the lead's latest message sets the language (any human language).

CONVERSATION STATE (when you are in an active sales chat with a lead):
- User type: If abusive or harassing → one calm boundary message and stop engaging (exit / block tone). If clearly time-wasting with no intent → very short polite exit. If genuine → continue qualification.
- Qualification (genuine leads): Naturally discover need, budget, and timeline; do not interrogate — one question at a time when it fits.
- Lead type (infer, do not label out loud unless helpful): Hot → priority handling (same-day call/meeting intent, schedule time, share location or link when relevant). Warm → follow-up rhythm (e.g. touchpoints over days), suggest next call in a reasonable window, move toward a meeting. Cold → lighter nurture / campaign-style value, lower frequency.
- Escalation: If the situation needs escalation and is critical → acknowledge human handover. Otherwise offer stronger help first (senior-style assurance in text, not a second persona name).
- Rating: When closing a resolved thread, you may ask for a quick satisfaction rating (1–10) in natural words.
- Score mindset: Very positive (8–10) → thank and soft referral ask when appropriate. Mid (5–7) → soft referral or feedback. Low (1–4) → try to resolve first; if still stuck, flag that the owner should follow up.
`;

/** Shared style rules so voice + WhatsApp sound like one human agent. */
const HUMAN_STYLE_CONSISTENCY_BLOCK = `
HUMAN STYLE & CROSS-CHANNEL CONSISTENCY (APPLIES TO ALL REPLIES):
- Sound like one real sales consultant, not a bot. Use natural short sentences and occasional conversational fillers when appropriate.
- Keep the same factual meaning across channels (voice/WhatsApp): do not contradict promised time, project facts, or next steps.
- If you commit to an action (call now, callback time, brochure, visit), state it clearly and concretely in one line.
- Prefer specific, project-grounded wording over generic corporate language.
- Avoid repetitive opening lines and avoid over-formal templates.
`;

const HUMAN_PERSONA_PRESETS = {
  friendly_consultant: `
PERSONA MODE: Friendly Consultant
- Warm, approachable, patient, and easy to understand.
- Prioritize trust-building and clarity over pressure.
`,
  premium_advisor: `
PERSONA MODE: Premium Advisor
- Calm, polished, and executive tone.
- Speak with confidence and structure, without sounding stiff.
`,
  concise_expert: `
PERSONA MODE: Concise Expert
- Compact, high-signal responses.
- Focus on the most decision-critical facts and one clear next step.
`,
};

function normalizeHumanPersonaPreset(raw) {
  const key = String(raw || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (HUMAN_PERSONA_PRESETS[key]) return key;
  return 'friendly_consultant';
}

function humanStyleConsistencyBlock(preset) {
  const key = normalizeHumanPersonaPreset(preset);
  return `${HUMAN_STYLE_CONSISTENCY_BLOCK}\n${HUMAN_PERSONA_PRESETS[key]}`;
}

/**
 * WhatsApp drafts — human tone + match the lead's message language.
 * @param {{ leadPreferredLocale?: string, leadTimezone?: string, humanPersona?: string }} [options]
 */
function buildWhatsAppSystemPrompt(options = {}) {
  const pref = String(options.leadPreferredLocale || 'hing').toLowerCase();
  const persona = normalizeHumanPersonaPreset(options.humanPersona);
  const tzNote = options.leadTimezone
    ? `\nLead timezone (use only when discussing times/dates): ${options.leadTimezone}`
    : '';
  const outboundFirst = Boolean(options.automationOutboundFirstMessage);
  const outboundBlock = outboundFirst
    ? `\nOUTBOUND AUTOMATION (first touch — no inbound reply in this thread yet):\n- Write this message in the lead's profile language (${pref}). Use natural phrasing for that locale (including Hinglish when pref is hing).\n- As soon as the lead replies, ignore this block: mirror only their **newest** message language per the rules below.\n`
    : '';

  return `You draft WhatsApp replies for a SalesPal sales rep responding to leads.
${outboundBlock}
LANGUAGE — HIGHEST PRIORITY (supports all languages):
- You must support **every language** the lead might use (any script, any mix, any locale — e.g. English, Hindi, Hinglish, Arabic, Tamil, Spanish, French, Japanese, etc.).
- **Only rule:** Your **entire** reply must be in the **same language(s), script, register, and code-mixing style** as the lead's **newest user message** in this request. **Mirror them; do not substitute** another language (do not translate their message into English or any other language unless they wrote in that language).
- The **newest user message alone** decides your reply language. Older messages are for facts/context only — do not copy the language of older assistant bubbles.
- If their message mixes languages, mirror that mix. If it uses one script/language, use that. Never default to English unless their newest text is clearly English-only.
- Lead profile hint (${pref}) is used **only** when the newest message has no identifiable language (e.g. lone emoji). It must never override a clear human language in their message.${tzNote}

TONE: Sound human in **that same language** — warm, conversational, like a real WhatsApp chat. Usually 2–6 short lines. Optional emoji if it fits (0–2). No bullet lists unless they asked.

RULES: Never use placeholders like [Your Name], [Name], or "Best regards, [Your Name]". Do not invent a fake personal name. If a sign-off is needed, use "— SalesPal Team" or omit it. Use the lead's first name when the prompt gives it.

THREAD: Stay consistent with facts; answer mainly what they asked in their latest message unless they want a recap.

${humanStyleConsistencyBlock(persona)}

${SALES_CONVERSATION_FUNNEL_BLOCK}`;
}

function systemPromptForChat(context, options = {}) {
  if (context === 'whatsapp') return buildWhatsAppSystemPrompt(options);
  return SYSTEM_PROMPT;
}

/**
 * Build a context-aware prompt for campaign analysis.
 */
function buildCampaignAnalysisPrompt(campaignData) {
  return `Analyze the following campaign performance data and provide actionable insights:

Campaign: ${campaignData.name}
Platform: ${campaignData.platform}
Status: ${campaignData.status}
Budget: ₹${campaignData.total_budget || 0}
Spend: ₹${campaignData.spend || 0}
Impressions: ${campaignData.impressions || 0}
Clicks: ${campaignData.clicks || 0}
Conversions: ${campaignData.conversions || 0}
Revenue: ₹${campaignData.revenue || 0}
CTR: ${campaignData.impressions > 0 ? ((campaignData.clicks / campaignData.impressions) * 100).toFixed(2) : 0}%
ROAS: ${campaignData.spend > 0 ? (campaignData.revenue / campaignData.spend).toFixed(2) : 0}x

Provide:
1. Performance summary (2-3 sentences)
2. Key strengths (bullet points)
3. Areas for improvement (bullet points)
4. Specific recommendations (numbered list)
5. Budget optimization suggestions`;
}

/**
 * Build a strategic insights prompt from aggregate analytics.
 */
function buildStrategicInsightsPrompt(analyticsData) {
  return `Based on the following marketing analytics summary, provide strategic insights:

Total Spend: ₹${analyticsData.total_spend}
Total Revenue: ₹${analyticsData.total_revenue}
ROAS: ${analyticsData.roas}x
Campaign Count: ${analyticsData.campaign_count}
Total Leads: ${analyticsData.total_leads}
Converted Leads: ${analyticsData.converted_leads}
Conversion Rate: ${analyticsData.conversion_rate}%

Platform Breakdown:
${(analyticsData.platforms || []).map(p => `- ${p.platform}: Spend ₹${p.spend}, Revenue ₹${p.revenue}, ROAS ${p.roas}x`).join('\n')}

Provide:
1. Executive summary (3-4 sentences)
2. Best performing channel and why
3. Underperforming areas with specific fixes
4. Budget reallocation recommendation
5. Next 30-day action plan (numbered steps)`;
}

function extractAssistantText(data) {
  const text =
    data?.text ??
    data?.output_text ??
    data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || '').join('') ??
    null;
  if (text) return String(text).trim() || 'No response generated.';
  return 'No response generated.';
}

let geminiClient = null;
function getGeminiModel() {
  const apiKey = String(env.ai.geminiApiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim();
  if (!apiKey) return null;
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(apiKey);
  return geminiClient.getGenerativeModel({ model: env.ai.model || 'gemini-2.5-flash' });
}

function classifyGeminiError(err) {
  const raw = String(err?.message || err || '');
  const msg = raw.toLowerCase();

  const out = {
    code: 'AI_GEMINI_RUNTIME_ERROR',
    statusCode: 502,
    userMessage: 'Gemini request failed. Please retry or check backend configuration.',
    providerMessage: raw.slice(0, 500),
  };

  if (msg.includes('api key') && (msg.includes('invalid') || msg.includes('not valid'))) {
    out.code = 'AI_GEMINI_INVALID_API_KEY';
    out.statusCode = 401;
    out.userMessage = 'Gemini API key is invalid. Check GOOGLE_GENERATIVE_AI_API_KEY.';
    return out;
  }
  if (msg.includes('permission') || msg.includes('forbidden') || msg.includes('403')) {
    out.code = 'AI_GEMINI_PERMISSION_DENIED';
    out.statusCode = 403;
    out.userMessage = 'Gemini permission denied. Verify project permissions and API access.';
    return out;
  }
  if (msg.includes('quota') || msg.includes('rate') || msg.includes('429') || msg.includes('resource_exhausted')) {
    out.code = 'AI_GEMINI_QUOTA_EXCEEDED';
    out.statusCode = 429;
    out.userMessage = 'Gemini quota/rate limit reached. Retry later or increase quota.';
    return out;
  }
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('unsupported') || msg.includes('unknown'))) {
    out.code = 'AI_GEMINI_MODEL_INVALID';
    out.statusCode = 400;
    out.userMessage = `Gemini model "${env.ai.model}" is invalid or unsupported.`;
    return out;
  }
  if (msg.includes('timeout') || msg.includes('deadline')) {
    out.code = 'AI_GEMINI_TIMEOUT';
    out.statusCode = 504;
    out.userMessage = 'Gemini request timed out. Please retry.';
    return out;
  }
  if (msg.includes('billing') || msg.includes('payment')) {
    out.code = 'AI_GEMINI_BILLING_REQUIRED';
    out.statusCode = 402;
    out.userMessage = 'Gemini billing is not enabled for this project.';
    return out;
  }

  return out;
}

/**
 * Call the external AI API with a prompt.
 * @param {string} userMessage — The user's message or generated prompt
 * @param {string} [systemPrompt] — Optional custom system prompt
 * @returns {Promise<string>} — The AI response text
 */
async function callAI(userMessage, systemPrompt = SYSTEM_PROMPT) {
  const model = getGeminiModel();
  if (!model) {
    const fromParsed = Boolean(String(env.ai.geminiApiKey || '').trim());
    const fromProcess = Boolean(String(process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim());
    const error = new Error(
      `Gemini key is missing in the running backend environment. GOOGLE_GENERATIVE_AI_API_KEY not detected at runtime (parsed=${fromParsed}, processEnv=${fromProcess}).`
    );
    error.statusCode = 400;
    error.code = 'AI_GEMINI_KEY_MISSING';
    throw error;
  }

  try {
    const prompt = `${systemPrompt}\n\nUser:\n${String(userMessage || '')}`;
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1500,
      },
    });
    const out = extractAssistantText({ text: result?.response?.text?.() || '' });
    if (out && out !== 'No response generated.') return out;
    logger.error('Gemini returned empty response');
    return 'No response generated.';
  } catch (err) {
    const classified = classifyGeminiError(err);
    logger.error('Gemini service call error', {
      code: classified.code,
      statusCode: classified.statusCode,
      providerMessage: classified.providerMessage,
    });
    const error = new Error(`${classified.userMessage} (${classified.providerMessage})`);
    error.statusCode = classified.statusCode;
    error.code = classified.code;
    throw error;
  }
}

/**
 * Chat Completions with full message list (system added here). Roles: user | assistant only in `messages`.
 * Last message should be `user` for a normal assistant reply.
 */
/**
 * @param {{
 *   temperature?: number,
 *   maxTokens?: number,
 *   maxCharsPerMessage?: number,
 *   responseFormat?: 'json_object',
 * }} [options] — lower temperature helps follow strict instructions (e.g. language match).
 * `responseFormat: 'json_object'` asks Gemini for JSON output.
 */
async function callAIWithMessages(chatMessages, systemPrompt, options = {}) {
  const model = getGeminiModel();
  if (!model) {
    const fromParsed = Boolean(String(env.ai.geminiApiKey || '').trim());
    const fromProcess = Boolean(String(process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim());
    const error = new Error(
      `Gemini key is missing in the running backend environment. GOOGLE_GENERATIVE_AI_API_KEY not detected at runtime (parsed=${fromParsed}, processEnv=${fromProcess}).`
    );
    error.statusCode = 400;
    error.code = 'AI_GEMINI_KEY_MISSING';
    throw error;
  }

  const maxChars =
    typeof options.maxCharsPerMessage === 'number' && options.maxCharsPerMessage > 0
      ? Math.min(options.maxCharsPerMessage, 200000)
      : 8000;

  const safe = [];
  for (const m of chatMessages || []) {
    if (!m || typeof m.content !== 'string') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content.trim().slice(0, maxChars);
    if (!content) continue;
    safe.push({ role, content });
  }

  if (safe.length === 0) {
    const err = new Error('callAIWithMessages requires at least one message');
    err.statusCode = 400;
    err.code = 'INVALID_CHAT_MESSAGES';
    throw err;
  }

  const messages = [{ role: 'system', content: systemPrompt }, ...safe.slice(-40)];

  const temperature =
    typeof options.temperature === 'number' && options.temperature >= 0 && options.temperature <= 2
      ? options.temperature
      : 0.7;

  const maxTokensRaw = options.maxTokens ?? 1500;
  const max_tokens = Math.min(Math.max(Number(maxTokensRaw) || 1500, 1), 16384);

  try {
    const transcript = messages
      .map((m) => `${m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User'}:\n${m.content}`)
      .join('\n\n');
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: max_tokens,
        ...(options.responseFormat === 'json_object' ? { responseMimeType: 'application/json' } : {}),
      },
    });
    const out = extractAssistantText({ text: result?.response?.text?.() || '' });
    if (out && out !== 'No response generated.') return out;
    logger.error('Gemini returned unexpected empty response');
    return 'No response generated.';
  } catch (err) {
    const classified = classifyGeminiError(err);
    logger.error('Gemini service call error', {
      code: classified.code,
      statusCode: classified.statusCode,
      providerMessage: classified.providerMessage,
    });
    const error = new Error(`${classified.userMessage} (${classified.providerMessage})`);
    error.statusCode = classified.statusCode;
    error.code = classified.code;
    throw error;
  }
}

/**
 * Gemini JSON-mode generation (parses reliably; avoids brittle regex trimming).
 */
async function generateContentJson(systemPrompt, userPrompt, options = {}) {
  const model = getGeminiModel();
  if (!model) {
    const fromParsed = Boolean(String(env.ai.geminiApiKey || '').trim());
    const fromProcess = Boolean(String(process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim());
    const error = new Error(
      `Gemini key is missing in the running backend environment. GOOGLE_GENERATIVE_AI_API_KEY not detected at runtime (parsed=${fromParsed}, processEnv=${fromProcess}).`
    );
    error.statusCode = 400;
    error.code = 'AI_GEMINI_KEY_MISSING';
    throw error;
  }

  const temperature =
    typeof options.temperature === 'number' && options.temperature >= 0 && options.temperature <= 2
      ? options.temperature
      : 0.08;
  const maxTokensRaw = options.maxOutputTokens ?? 8192;
  const maxOutputTokens = Math.min(Math.max(Number(maxTokensRaw) || 8192, 256), 16384);

  const prompt = `${String(systemPrompt || '')}\n\nUser:\n${String(userPrompt || '')}`;

  try {
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
      },
    });
    const raw = extractAssistantText({ text: result?.response?.text?.() || '' });
    if (!raw || raw === 'No response generated.') {
      throw new Error('Gemini returned empty JSON response');
    }
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      const wrap = new Error(`Failed to parse Gemini JSON: ${String(err.message).slice(0, 200)}`);
      wrap.statusCode = 502;
      wrap.code = 'AI_JSON_PARSE_ERROR';
      throw wrap;
    }
    const classified = classifyGeminiError(err);
    logger.error('Gemini JSON generation error', {
      code: classified.code,
      statusCode: classified.statusCode,
      providerMessage: classified.providerMessage,
    });
    const error = new Error(`${classified.userMessage} (${classified.providerMessage})`);
    error.statusCode = classified.statusCode;
    error.code = classified.code;
    throw error;
  }
}

/**
 * Multimodal: inline PDF bytes + prompts → structured JSON object.
 */
async function generateJsonWithPdf(systemPrompt, userTextPrompt, pdfBuffer, options = {}) {
  const model = getGeminiModel();
  if (!model) {
    const fromParsed = Boolean(String(env.ai.geminiApiKey || '').trim());
    const fromProcess = Boolean(String(process.env.GOOGLE_GENERATIVE_AI_API_KEY || '').trim());
    const error = new Error(
      `Gemini key is missing in the running backend environment. GOOGLE_GENERATIVE_AI_API_KEY not detected at runtime (parsed=${fromParsed}, processEnv=${fromProcess}).`
    );
    error.statusCode = 400;
    error.code = 'AI_GEMINI_KEY_MISSING';
    throw error;
  }

  const buf = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer || []);
  const b64 = buf.toString('base64');

  const temperature =
    typeof options.temperature === 'number' && options.temperature >= 0 && options.temperature <= 2
      ? options.temperature
      : 0.08;
  const maxTokensRaw = options.maxOutputTokens ?? 8192;
  const maxOutputTokens = Math.min(Math.max(Number(maxTokensRaw) || 8192, 256), 16384);

  const head = `${String(systemPrompt || '')}\n\n${String(userTextPrompt || '')}`;

  try {
    const result = await model.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: head },
            { inlineData: { mimeType: 'application/pdf', data: b64 } },
          ],
        },
      ],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
      },
    });
    const raw = extractAssistantText({ text: result?.response?.text?.() || '' });
    if (!raw || raw === 'No response generated.') {
      throw new Error('Gemini returned empty JSON response for PDF extraction');
    }
    return JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      const wrap = new Error(`Failed to parse Gemini PDF JSON: ${String(err.message).slice(0, 200)}`);
      wrap.statusCode = 502;
      wrap.code = 'AI_JSON_PARSE_ERROR';
      throw wrap;
    }
    const classified = classifyGeminiError(err);
    logger.error('Gemini PDF JSON generation error', {
      code: classified.code,
      statusCode: classified.statusCode,
      providerMessage: classified.providerMessage,
    });
    const error = new Error(`${classified.userMessage} (${classified.providerMessage})`);
    error.statusCode = classified.statusCode;
    error.code = classified.code;
    throw error;
  }
}

async function streamAIWithMessages(chatMessages, systemPrompt, options = {}) {
  const model = getGeminiModel();
  if (!model) {
    throw new Error('Gemini model not available');
  }

  const maxChars =
    typeof options.maxCharsPerMessage === 'number' && options.maxCharsPerMessage > 0
      ? Math.min(options.maxCharsPerMessage, 200000)
      : 8000;

  const safe = [];
  for (const m of chatMessages || []) {
    if (!m || typeof m.content !== 'string') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content.trim().slice(0, maxChars);
    if (!content) continue;
    safe.push({ role, content });
  }
  if (!safe.length) throw new Error('No chat messages');

  const messages = [{ role: 'system', content: systemPrompt }, ...safe.slice(-40)];
  const temperature =
    typeof options.temperature === 'number' && options.temperature >= 0 && options.temperature <= 2
      ? options.temperature : 0.7;
  const maxTokensRaw = options.maxTokens ?? 1500;
  const max_tokens = Math.min(Math.max(Number(maxTokensRaw) || 1500, 1), 16384);

  const transcript = messages
    .map((m) => `${m.role === 'system' ? 'System' : m.role === 'assistant' ? 'Assistant' : 'User'}:\n${m.content}`)
    .join('\n\n');

  const result = await model.generateContentStream({
    contents: [{ role: 'user', parts: [{ text: transcript }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: max_tokens,
    },
  });
  return result.stream;
}

module.exports = {
  SYSTEM_PROMPT,
  SALES_CONVERSATION_FUNNEL_BLOCK,
  HUMAN_STYLE_CONSISTENCY_BLOCK,
  normalizeHumanPersonaPreset,
  humanStyleConsistencyBlock,
  buildWhatsAppSystemPrompt,
  systemPromptForChat,
  buildCampaignAnalysisPrompt,
  buildStrategicInsightsPrompt,
  callAI,
  callAIWithMessages,
  streamAIWithMessages,
  generateContentJson,
  generateJsonWithPdf,
};
