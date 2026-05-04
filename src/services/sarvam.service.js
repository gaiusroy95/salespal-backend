/**
 * Sarvam AI Bulbul TTS — Indian-language speech for voice bot playback.
 * Docs: https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert
 */

const DEFAULT_TTS_URL = 'https://api.sarvam.ai/text-to-speech';

function isSarvamTtsConfigured(env) {
  const key =
    env?.integrations?.sarvamApiKey ||
    String(process.env.SARVAM_API_SUBSCRIPTION_KEY || process.env.SARVAM_API_KEY || '').trim();
  return Boolean(key);
}

/** Map SalesPal locale codes to Sarvam target_language_code (India-first). */
function sarvamLanguageFromLocale(locale) {
  const l = String(locale || 'en').toLowerCase().replace('_', '-');
  if (/^hi(\b|-|)/i.test(l) || l === 'hin' || l === 'hing' || l === 'hinglish') return 'hi-IN';
  if (l.startsWith('mr')) return 'mr-IN';
  if (l.startsWith('ta')) return 'ta-IN';
  if (l.startsWith('te')) return 'te-IN';
  if (l.startsWith('kn')) return 'kn-IN';
  if (l.startsWith('ml')) return 'ml-IN';
  if (l.startsWith('gu')) return 'gu-IN';
  if (l.startsWith('bn')) return 'bn-IN';
  if (l.startsWith('pa')) return 'pa-IN';
  if (l.startsWith('ur')) return 'ur-IN';
  if (l.startsWith('en')) return 'en-IN';
  return 'hi-IN';
}

/**
 * Synthesize speech; returns WAV bytes (Bulbul REST default).
 */
async function synthesizeSpeech({
  env,
  text,
  locale = 'hing',
  speaker,
  model = 'bulbul:v3',
  speechSampleRate = '24000',
}) {
  const apiKey =
    env?.integrations?.sarvamApiKey ||
    String(process.env.SARVAM_API_SUBSCRIPTION_KEY || process.env.SARVAM_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('Sarvam TTS is not configured (set SARVAM_API_SUBSCRIPTION_KEY)');
    err.code = 'SARVAM_NOT_CONFIGURED';
    throw err;
  }

  const trimmed = String(text || '').trim().slice(0, 2490);
  if (!trimmed) {
    throw new Error('Empty text for TTS');
  }

  const endpoint = String(
    env?.integrations?.sarvamTtsUrl || process.env.SARVAM_TTS_URL || DEFAULT_TTS_URL
  ).replace(/\/$/, '');

  const target_language_code =
    env?.integrations?.sarvamDefaultLanguage ||
    process.env.SARVAM_TARGET_LANGUAGE_CODE ||
    sarvamLanguageFromLocale(locale);

  const body = {
    text: trimmed,
    target_language_code,
    model: model || env?.integrations?.sarvamModel || process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
    speech_sample_rate: String(speechSampleRate || env?.integrations?.sarvamSampleRate || '24000'),
  };

  const sp = speaker || env?.integrations?.sarvamSpeaker || process.env.SARVAM_TTS_SPEAKER;
  if (sp) body.speaker = sp;

  const pace = Number(env?.integrations?.sarvamPace ?? process.env.SARVAM_TTS_PACE);
  if (Number.isFinite(pace) && pace >= 0.5 && pace <= 2.0) {
    body.pace = pace;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-subscription-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Sarvam TTS failed (${res.status}): ${txt.slice(0, 400)}`);
  }

  const data = await res.json();
  const b64 =
    Array.isArray(data?.audios) && data.audios[0]
      ? data.audios[0]
      : typeof data?.audio === 'string'
        ? data.audio
        : null;

  if (!b64) {
    throw new Error(`Sarvam TTS unexpected response shape: ${JSON.stringify(Object.keys(data || {}))}`);
  }

  return {
    mimeType: 'audio/wav',
    buffer: Buffer.from(b64, 'base64'),
    requestId: data?.request_id || null,
    target_language_code,
  };
}

module.exports = {
  DEFAULT_TTS_URL,
  isSarvamTtsConfigured,
  sarvamLanguageFromLocale,
  synthesizeSpeech,
};
