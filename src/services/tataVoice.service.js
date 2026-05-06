const axios = require('axios');
const env = require('../config/env');
const logger = require('../config/logger');

function isTelephonyEnabled() {
  return Boolean(env.telephony?.enabled);
}

function resolveApiStyle() {
  const raw = String(env.telephony?.apiStyle || 'auto').trim().toLowerCase();
  const path = String(env.telephony?.endpointPath || '').toLowerCase();
  if (raw === 'legacy' || raw === 'support') return raw;
  if (path.includes('click_to_call_support')) return 'support';
  if (String(env.telephony?.supportApiKey || '').trim()) return 'support';
  return 'legacy';
}

function resolveEndpointPathForStyle(style) {
  const configured = String(env.telephony?.endpointPath || '/v1/click_to_call').trim();
  if (style !== 'support') return configured || '/v1/click_to_call';
  if (configured.toLowerCase().includes('click_to_call_support')) return configured;
  /** Auto-heal common misconfig: Support API style with legacy endpoint path. */
  return '/v1/click_to_call_support';
}

let legacyModeWarned = false;

function warnLegacyNoVoiceBot() {
  if (legacyModeWarned) return;
  legacyModeWarned = true;
  logger.warn(
    '[telephony] Tata legacy /v1/click_to_call only connects Smartflo’s configured leg; it does not stream SalesPal text. ' +
      'For project-specific speech on the handset, use Smartflo “Click to Call Support API” with destination = Voice Bot ' +
      '(see https://docs.smartflo.tatatelebusiness.com/docs/copy-of-standard-operating-procedure-sop-for-voice-streaming) ' +
      'and set TATA_CALL_ENDPOINT_PATH=/v1/click_to_call_support plus TATA_CALL_API_STYLE=support (or path-based auto).'
  );
}

function buildAuthHeader() {
  const scheme = String(env.telephony?.authScheme || 'Bearer').trim();
  const key = String(env.telephony?.apiKey || '').trim();
  if (!key) return null;
  if (!scheme || scheme.toLowerCase() === 'none') return key;
  if (scheme.toLowerCase() === 'basic') return `Basic ${key}`;
  return `${scheme} ${key}`;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').trim();
  if (!p) return b;
  if (/^https?:\/\//i.test(p)) return p;
  return `${b}/${p.replace(/^\/+/, '')}`;
}

function normalizeDialNumber(rawNumber, { assumeIndianFor10Digit = true } = {}) {
  const raw = String(rawNumber || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';
  // Accept "00" international prefix and convert to plain country-code digits.
  if (digits.startsWith('00')) digits = digits.slice(2);
  // Common India CRM input: local 10-digit mobile without country code.
  if (assumeIndianFor10Digit && /^\d{10}$/.test(digits)) {
    digits = `91${digits}`;
  }
  return digits;
}

function buildDialVariants(rawDigits, { forDestination = false } = {}) {
  const base = String(rawDigits || '').replace(/[^\d]/g, '');
  if (!base) return [];
  const out = [];
  const push = (v) => {
    const s = String(v || '').replace(/[^\d]/g, '');
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  push(base);
  if (base.startsWith('91') && base.length === 12) push(base.slice(2)); // Smartflo configs that expect local mobile
  if (/^\d{10}$/.test(base)) push(`91${base}`); // Smartflo configs that expect country code
  if (forDestination && base.startsWith('0') && base.length > 10) push(base.replace(/^0+/, ''));
  return out;
}

const OPENER_PAYLOAD_MAX_LEN = 950;
const CUSTOM_IDENTIFIER_MAX_LEN = 1800;

function buildCustomIdentifierPayload({ conversationId, opener, projectName, projectId, leadName, locale }) {
  const base = {
    v: 1,
    salespal_conversation_id: conversationId,
    project_name: projectName ? String(projectName).trim().slice(0, 240) : '',
    project_id: projectId ? String(projectId).trim().slice(0, 120) : '',
    opener: String(opener || '').trim().slice(0, 720),
    lead_name: leadName ? String(leadName).trim().slice(0, 120) : '',
    locale: locale ? String(locale).trim().slice(0, 40) : '',
  };
  let s = JSON.stringify(base);
  if (s.length <= CUSTOM_IDENTIFIER_MAX_LEN) return s;
  base.opener = String(opener || '').trim().slice(0, 360);
  s = JSON.stringify(base);
  if (s.length <= CUSTOM_IDENTIFIER_MAX_LEN) return s;
  base.opener = String(opener || '').trim().slice(0, 200);
  return JSON.stringify(base).slice(0, CUSTOM_IDENTIFIER_MAX_LEN);
}

/**
 * Legacy Smartflo click_to_call — dials agent + customer per account rules; extra JSON fields are usually ignored.
 */
async function postLegacyClickToCall(apiUrl, headers, payloadBase) {
  const destinationNumber = payloadBase.destinationNumber;
  const agentNumber = payloadBase.agentNumber;
  const callerId = payloadBase.callerId;
  const openerTrimmed = payloadBase.openerTrimmed;
  const pn = payloadBase.pn;
  const pid = payloadBase.pid;
  const { conversationId, leadName } = payloadBase;

  const salespal = {
    conversation_id: conversationId,
    opener: openerTrimmed,
    ...(pn ? { project_name: pn } : {}),
    ...(pid ? { project_id: pid } : {}),
    ...(payloadBase.locale ? { locale: String(payloadBase.locale).slice(0, 40) } : {}),
  };

  const customIdentifier = buildCustomIdentifierPayload({
    conversationId,
    opener: openerTrimmed,
    projectName: pn,
    projectId: pid,
    leadName,
    locale: payloadBase.locale,
  });

  const payload = {
    async: Number(env.telephony.asyncMode ?? 1),
    agent_number: agentNumber || undefined,
    destination_number: destinationNumber || undefined,
    caller_id: callerId || undefined,
    call_timeout: Number(env.telephony.ringTimeoutMs ?? 3500),
    get_call_id: Number(env.telephony.getCallId ?? 1),
    ...env.telephony.staticPayload,
    leadName: leadName || undefined,
    conversationId,
    webhookUrl: env.telephony.statusWebhookUrl || undefined,
    custom_identifier: customIdentifier,
    opening_message: openerTrimmed,
    opening_line: openerTrimmed,
    ...(pn ? { project_name: pn, salespal_listing_name: pn } : {}),
    ...(pid ? { salespal_project_id: pid } : {}),
    salespal,
    ai: {
      opener: openerTrimmed,
      opening_line: openerTrimmed,
      ...(pn ? { project_listing_name: pn } : {}),
    },
  };

  warnLegacyNoVoiceBot();

  logger.info('[telephony] Tata legacy click_to_call request', {
    destination_tail: destinationNumber.slice(-4),
    opener_len: openerTrimmed.length,
    has_project: Boolean(pn),
  });

  return axios.post(apiUrl, payload, {
    headers,
    timeout: env.telephony.timeoutMs,
    validateStatus: () => true,
  });
}

/**
 * Smartflo Click to Call Support API — outbound calls that attach to a Voice Bot (WebSocket streaming).
 * Docs: webhook returns custom_identifier; Voice Bot destination is bound to this API key in the portal.
 */
async function postSupportClickToCall(apiUrl, payloadBase) {
  const destinationNumber = payloadBase.destinationNumber;
  const callerId = payloadBase.callerId;
  const openerTrimmed = payloadBase.openerTrimmed;
  const pn = payloadBase.pn;
  const pid = payloadBase.pid;
  const supportKey =
    String(env.telephony.supportApiKey || '').trim() || String(env.telephony.apiKey || '').trim();
  if (!supportKey) {
    const err = new Error('Tata Support API requires api_key in body (set TATA_CALL_API_KEY or TATA_CALL_SUPPORT_API_KEY).');
    err.code = 'TATA_CONFIG_ERROR';
    throw err;
  }

  const ringMs = Number(env.telephony.ringTimeoutMs ?? 30000);
  const ringSec = Math.max(10, Math.min(30, Math.ceil(ringMs / 1000)));

  const custom_identifier = buildCustomIdentifierPayload({
    conversationId: payloadBase.conversationId,
    opener: openerTrimmed,
    projectName: pn,
    projectId: pid,
    leadName: payloadBase.leadName,
    locale: payloadBase.locale,
  });

  const payload = {
    ...env.telephony.staticPayload,
    api_key: supportKey,
    customer_number: destinationNumber,
    async: Number(env.telephony.asyncMode ?? 1) || 1,
    ...(callerId ? { caller_id: callerId } : {}),
    customer_ring_timeout: ringSec,
    custom_identifier,
  };

  logger.info('[telephony] Tata click_to_call_support request', {
    destination_tail: destinationNumber.slice(-4),
    opener_len: openerTrimmed.length,
    has_project: Boolean(pn),
    custom_identifier_len: custom_identifier.length,
  });

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...env.telephony.extraHeaders,
  };

  return axios.post(apiUrl, payload, {
    headers,
    timeout: env.telephony.timeoutMs,
    validateStatus: () => true,
  });
}

async function postSupportWithSmartRetries(apiUrl, payloadBase) {
  const destinationVariants = buildDialVariants(payloadBase.destinationNumber, { forDestination: true });
  const callerVariants = buildDialVariants(payloadBase.callerId, { forDestination: false });
  const callerCandidates = callerVariants.length ? callerVariants : [''];
  const attempts = [];
  for (const destinationNumber of destinationVariants) {
    for (const callerId of callerCandidates) {
      attempts.push({ destinationNumber, callerId });
    }
    // Also attempt without caller_id once per destination for strict portal configs.
    attempts.push({ destinationNumber, callerId: '' });
  }

  let lastResponse = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const a = attempts[i];
    const response = await postSupportClickToCall(apiUrl, {
      ...payloadBase,
      destinationNumber: a.destinationNumber,
      callerId: a.callerId,
    });
    if (response.status >= 200 && response.status < 300) return response;
    lastResponse = response;
    if (response.status !== 422) return response;
    logger.warn('[telephony] Support API 422; retrying with alternate dial format', {
      attempt: i + 1,
      destination_len: a.destinationNumber.length,
      caller_present: Boolean(a.callerId),
      status: response.status,
    });
  }
  return lastResponse;
}

async function placeOutboundCall({
  to,
  leadName,
  conversationId,
  opener,
  projectName = null,
  projectId = null,
  locale = null,
}) {
  if (!isTelephonyEnabled()) {
    return {
      enabled: false,
      provider: 'tata',
      accepted: false,
      reason: 'Telephony provider is disabled',
    };
  }

  const apiBase = String(env.telephony?.apiUrl || '').trim();
  if (!apiBase) {
    const err = new Error('Tata telephony is enabled but TATA_CALL_API_URL is missing.');
    err.code = 'TATA_CONFIG_ERROR';
    throw err;
  }
  const endpointPath = resolveEndpointPathForStyle(resolveApiStyle());
  const apiUrl = joinUrl(apiBase, endpointPath);
  const apiStyle = resolveApiStyle();

  const destinationNumber = normalizeDialNumber(to, { assumeIndianFor10Digit: true });
  const agentNumber = normalizeDialNumber(env.telephony.fromNumber, { assumeIndianFor10Digit: false });
  const callerId = normalizeDialNumber(env.telephony.fromNumber, { assumeIndianFor10Digit: false });
  const openerTrimmed = String(opener || '').trim().slice(0, OPENER_PAYLOAD_MAX_LEN);
  const pn = projectName ? String(projectName).trim().slice(0, 240) : '';
  const pid = projectId ? String(projectId).trim().slice(0, 120) : '';

  if (!destinationNumber || destinationNumber.length < 8 || destinationNumber.length > 15) {
    const err = new Error(
      'Invalid destination phone for Tata call. Use full mobile with country code (e.g. 91XXXXXXXXXX).'
    );
    err.code = 'TATA_INVALID_DESTINATION_PHONE';
    err.details = { provided: String(to || '') };
    throw err;
  }

  if (apiStyle === 'legacy' && pn) {
    logger.warn(
      '[telephony] Legacy click_to_call active with project context: call will continue, but listing-specific speech is not guaranteed on handset.'
    );
  }

  const payloadBase = {
    destinationNumber,
    agentNumber,
    callerId,
    openerTrimmed,
    pn,
    pid,
    conversationId,
    leadName,
    locale,
  };

  try {
    let response;
    if (apiStyle === 'support') {
      response = await postSupportWithSmartRetries(apiUrl, payloadBase);
    } else {
      const authHeader = buildAuthHeader();
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...env.telephony.extraHeaders,
      };
      if (authHeader) headers.Authorization = authHeader;
      response = await postLegacyClickToCall(apiUrl, headers, payloadBase);
    }

    if (response.status < 200 || response.status >= 300) {
      const err = new Error(
        `Tata API rejected call request with status ${response.status}.`
      );
      err.code = 'TATA_CALL_REJECTED';
      err.details = response.data;
      throw err;
    }

    const data = response.data || {};
    return {
      enabled: true,
      provider: 'tata',
      accepted: true,
      apiStyle,
      statusCode: response.status,
      providerCallId:
        data.callId ||
        data.call_id ||
        data.uuid ||
        data.call_to_number ||
        data.requestId ||
        data.request_id ||
        data.id ||
        null,
      raw: data,
    };
  } catch (error) {
    const err = new Error(error.message || 'Failed to place outbound call via Tata API.');
    err.code = error.code || 'TATA_CALL_FAILED';
    err.details = error.details || error.response?.data || null;
    throw err;
  }
}

module.exports = {
  isTelephonyEnabled,
  placeOutboundCall,
  parseJsonObject,
  resolveApiStyle,
};
