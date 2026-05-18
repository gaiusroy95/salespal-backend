/**
 * ElevenLabs TTS for premium_voice_elevenlabs profile.
 */
const logger = require('../config/logger');

function getApiKey(env) {
  return String(env?.voice?.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '').trim();
}

function isElevenLabsConfigured(env) {
  return Boolean(getApiKey(env));
}

async function synthesizeSpeech({ env, text, profile, voiceId }) {
  const apiKey = getApiKey(env);
  if (!apiKey) {
    const err = new Error('ElevenLabs is not configured (set ELEVENLABS_API_KEY)');
    err.code = 'ELEVENLABS_NOT_CONFIGURED';
    throw err;
  }

  const model = String(profile?.tts?.model || 'eleven_turbo_v2_5').trim();
  const vid =
    voiceId ||
    String(env?.voice?.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || '').trim() ||
    'EXAVITQu4vr4xnSDxMaL';

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: String(text || '').slice(0, 2500),
      model_id: model,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const mp3 = Buffer.from(await res.arrayBuffer());
  logger.debug('[elevenlabs] synthesized', { bytes: mp3.length, model });
  return { buffer: mp3, mimeType: 'audio/mpeg', provider: 'elevenlabs' };
}

module.exports = {
  isElevenLabsConfigured,
  synthesizeSpeech,
};
