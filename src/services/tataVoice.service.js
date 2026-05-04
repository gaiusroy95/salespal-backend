const axios = require('axios');
const env = require('../config/env');

function isTelephonyEnabled() {
  return Boolean(env.telephony?.enabled);
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

async function placeOutboundCall({ to, leadName, conversationId, opener }) {
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
  const apiUrl = joinUrl(apiBase, env.telephony?.endpointPath || '/v1/click_to_call');

  const authHeader = buildAuthHeader();
  const headers = {
    'Content-Type': 'application/json',
    ...env.telephony.extraHeaders,
  };
  if (authHeader) headers.Authorization = authHeader;

  const destinationNumber = String(to || '').replace(/[^\d]/g, '');
  const agentNumber = String(env.telephony.fromNumber || '').replace(/[^\d]/g, '');
  const callerId = String(env.telephony.fromNumber || '').replace(/[^\d]/g, '');
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
    ai: {
      opener: String(opener || '').slice(0, 600),
    },
  };

  try {
    const response = await axios.post(apiUrl, payload, {
      headers,
      timeout: env.telephony.timeoutMs,
      validateStatus: () => true,
    });

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
};
