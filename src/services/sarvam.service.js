/**
 * Sarvam AI Bulbul TTS — Indian-language speech for voice bot playback.
 * Docs: https://docs.sarvam.ai/api-reference-docs/text-to-speech/convert
 *
 * STT REST: POST https://api.sarvam.ai/speech-to-text (multipart file)
 * Docs: https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe
 */

const DEFAULT_TTS_URL = 'https://api.sarvam.ai/text-to-speech';
const DEFAULT_STT_URL = 'https://api.sarvam.ai/speech-to-text';

function getSarvamApiKey(env) {
  return (
    env?.integrations?.sarvamApiKey ||
    String(process.env.SARVAM_API_SUBSCRIPTION_KEY || process.env.SARVAM_API_KEY || '').trim()
  );
}

function isSarvamTtsConfigured(env) {
  return Boolean(getSarvamApiKey(env));
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

/** STT: treat Hinglish / unknown lead locale as auto-detect. */
function sttLanguageCodeFromLocale(locale) {
  const l = String(locale || '').toLowerCase().replace('_', '-');
  if (!l || l === 'hing' || l === 'hinglish' || l === 'mixed') return 'unknown';
  return sarvamLanguageFromLocale(locale);
}

/**
 * Transcribe a short buffered recording (multipart REST; keep clips under ~30s per Sarvam docs).
 */
async function transcribeBufferedAudio({
  env,
  buffer,
  filename = 'utterance.webm',
  mimeType = '',
  locale = 'hing',
  model,
  mode,
}) {
  const apiKey = getSarvamApiKey(env);
  if (!apiKey) {
    const err = new Error('Sarvam is not configured (set SARVAM_API_SUBSCRIPTION_KEY)');
    err.code = 'SARVAM_NOT_CONFIGURED';
    throw err;
  }

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) {
    throw new Error('Empty audio payload');
  }
  const maxBytes = 8 * 1024 * 1024;
  if (buf.length > maxBytes) {
    throw new Error('Audio file too large');
  }

  const endpoint = String(env?.integrations?.sarvamSttUrl || process.env.SARVAM_STT_URL || DEFAULT_STT_URL)
    .trim()
    .replace(/\/$/, '');

  const sttModel =
    model ||
    env?.integrations?.sarvamSttModel ||
    String(process.env.SARVAM_STT_MODEL || 'saaras:v3').trim();

  const sttModeRaw =
    mode ||
    env?.integrations?.sarvamSttMode ||
    String(process.env.SARVAM_STT_MODE || 'codemix').trim();

  const language_code = sttLanguageCodeFromLocale(locale);

  const safeName =
    String(filename || 'recording.webm').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || 'recording.webm';
  const type =
    mimeType ||
    (safeName.endsWith('.webm') ? 'audio/webm' : safeName.endsWith('.wav') ? 'audio/wav' : 'application/octet-stream');

  const form = new FormData();
  const bodyBuf = Uint8Array.from(buf);
  const blob = new Blob([bodyBuf], { type });
  form.append('file', blob, safeName);
  form.append('model', sttModel);
  form.append('language_code', language_code);
  const isSaaras = String(sttModel).toLowerCase().includes('saaras');
  if (isSaaras && sttModeRaw) {
    form.append('mode', String(sttModeRaw));
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey,
    },
    body: form,
    signal: AbortSignal.timeout(55000),
  });

  const rawText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Sarvam STT failed (${res.status}): ${rawText.slice(0, 480)}`);
  }

  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    throw new Error(`Sarvam STT invalid JSON: ${rawText.slice(0, 200)}`);
  }

  const transcript = typeof data?.transcript === 'string' ? data.transcript.trim() : '';
  return {
    transcript,
    request_id: data?.request_id || null,
    language_requested: language_code,
    model: sttModel,
  };
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
  const apiKey = getSarvamApiKey(env);
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
  DEFAULT_STT_URL,
  isSarvamTtsConfigured,
  sarvamLanguageFromLocale,
  sttLanguageCodeFromLocale,
  transcribeBufferedAudio,
  synthesizeSpeech,
};
