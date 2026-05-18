/**
 * Deepgram Nova real-time STT (REST batch for buffered utterances).
 * Uses endpointing tuned for Indian conversational pauses when configured on profile.
 */
const logger = require('../config/logger');

function getApiKey(env) {
  return String(env?.voice?.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '').trim();
}

function isDeepgramConfigured(env) {
  return Boolean(getApiKey(env));
}

/**
 * @param {Buffer} wavBuffer - PCM16 WAV at profile input rate (typically 16 kHz)
 */
async function transcribeWav({ env, wavBuffer, locale = 'hing', profile }) {
  const apiKey = getApiKey(env);
  if (!apiKey) {
    const err = new Error('Deepgram is not configured (set DEEPGRAM_API_KEY)');
    err.code = 'DEEPGRAM_NOT_CONFIGURED';
    throw err;
  }

  const model = String(profile?.stt?.model || 'nova-2').trim();
  const endpointing = Number(profile?.stt?.endpointingMs || 300);
  const language = String(profile?.stt?.language || 'hi').trim();

  const params = new URLSearchParams({
    model,
    language,
    punctuate: 'true',
    smart_format: 'true',
    endpointing: String(endpointing),
  });

  const url = `https://api.deepgram.com/v1/listen?${params.toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'audio/wav',
    },
    body: wavBuffer,
    signal: AbortSignal.timeout(45000),
  });

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Deepgram STT failed (${res.status}): ${raw.slice(0, 400)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('Deepgram returned non-JSON');
  }

  const transcript = String(
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
  ).trim();

  logger.debug('[deepgram] transcript', {
    len: transcript.length,
    endpointing,
    model,
  });

  return {
    transcript,
    provider: 'deepgram',
    language_code: data?.results?.channels?.[0]?.detected_language || language,
    raw: data,
  };
}

module.exports = {
  isDeepgramConfigured,
  transcribeWav,
};
