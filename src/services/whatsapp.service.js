const axios = require('axios');
const env = require('../config/env');

function isWhatsAppEnabled() {
  return Boolean(env.whatsapp?.enabled && env.whatsapp?.apiUrl && env.whatsapp?.accessToken);
}

function normalizeWhatsAppPhone(phone) {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  return raw.replace(/[^\d]/g, '');
}

async function sendWhatsAppText({ to, text }) {
  if (!isWhatsAppEnabled()) {
    const err = new Error('WhatsApp API is not configured');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }
  const toPhone = normalizeWhatsAppPhone(to);
  if (!toPhone) {
    const err = new Error('Valid destination phone is required for WhatsApp');
    err.code = 'WHATSAPP_INVALID_PHONE';
    throw err;
  }
  const bodyText = String(text || '').trim();
  if (!bodyText) {
    const err = new Error('Message text is required for WhatsApp');
    err.code = 'WHATSAPP_EMPTY_TEXT';
    throw err;
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'text',
    text: {
      preview_url: false,
      body: bodyText,
    },
  };

  const response = await axios.post(env.whatsapp.apiUrl, payload, {
    timeout: env.whatsapp.timeoutMs || 10000,
    headers: {
      Authorization: `Bearer ${env.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const raw = response?.data || {};
  const messageId =
    raw?.messages?.[0]?.id ||
    raw?.message_id ||
    raw?.messages?.[0]?.message_id ||
    null;

  return {
    provider: 'meta_whatsapp_cloud',
    accepted: true,
    messageId,
    raw,
  };
}

/**
 * Send an approved WhatsApp Cloud template message (names must exist in WhatsApp Manager).
 */
async function sendWhatsAppTemplate({ to, templateName, languageCode = 'en', bodyParameters = [], headerDocument = null }) {
  if (!isWhatsAppEnabled()) {
    const err = new Error('WhatsApp API is not configured');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }
  const toPhone = normalizeWhatsAppPhone(to);
  if (!toPhone) {
    const err = new Error('Valid destination phone is required for WhatsApp');
    err.code = 'WHATSAPP_INVALID_PHONE';
    throw err;
  }
  const name = String(templateName || '').trim();
  if (!name) {
    const err = new Error('template name is required');
    err.code = 'WHATSAPP_BAD_TEMPLATE';
    throw err;
  }

  const components = [];
  if (Array.isArray(bodyParameters) && bodyParameters.length) {
    components.push({
      type: 'body',
      parameters: bodyParameters.map((x) =>
        typeof x === 'string'
          ? { type: 'text', text: x.slice(0, 2048) }
          : x && typeof x === 'object' && x.type
            ? x
            : { type: 'text', text: String(x || '').slice(0, 2048) }
      ),
    });
  }
  if (headerDocument?.link) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'document',
          document: {
            link: String(headerDocument.link).slice(0, 2048),
            filename: String(headerDocument.filename || 'catalogue.pdf').slice(0, 240),
          },
        },
      ],
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'template',
    template: {
      name,
      language: { code: String(languageCode || 'en').slice(0, 12) },
      ...(components.length ? { components } : {}),
    },
  };

  const response = await axios.post(env.whatsapp.apiUrl, payload, {
    timeout: env.whatsapp.timeoutMs || 10000,
    headers: {
      Authorization: `Bearer ${env.whatsapp.accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  const raw = response?.data || {};
  const messageId =
    raw?.messages?.[0]?.id ||
    raw?.message_id ||
    raw?.messages?.[0]?.message_id ||
    null;

  return {
    provider: 'meta_whatsapp_cloud',
    accepted: response.status >= 200 && response.status < 300,
    messageId,
    raw,
  };
}

module.exports = {
  isWhatsAppEnabled,
  sendWhatsAppText,
  sendWhatsAppTemplate,
};

