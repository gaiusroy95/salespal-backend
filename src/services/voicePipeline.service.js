/**
 * Route STT/TTS through the active voice stack profile + audio bridge.
 */
const env = require('../config/env');
const { resolveVoiceStackProfile } = require('../config/voiceStackProfiles');
const voiceAudioBridge = require('./voiceAudioBridge.service');
const sarvamService = require('./sarvam.service');
const deepgramService = require('./deepgram.service');
const elevenlabsService = require('./elevenlabs.service');
const logger = require('../config/logger');

function resolveProfile(sessionOrId) {
  const id = sessionOrId?.voiceProfileId || sessionOrId;
  return resolveVoiceStackProfile(id);
}

async function transcribeTelephonyUtterance({ mulawBuf, locale, session }) {
  const profile = resolveProfile(session);
  const bridged = voiceAudioBridge.telephonyMulawToSttWav(mulawBuf, profile);
  const sttProvider = String(profile.stt?.provider || 'sarvam');

  if (sttProvider === 'deepgram' && deepgramService.isDeepgramConfigured(env)) {
    const result = await deepgramService.transcribeWav({
      env,
      wavBuffer: bridged.buffer,
      locale,
      profile,
    });
    return { ...result, bridge: { inputRateHz: bridged.sampleRateHz, sttExtras: bridged.sttExtras } };
  }

  if (sttProvider === 'gemini_live') {
    logger.info('[voicePipeline] gemini_live STT — using Sarvam REST bridge until Live audio ingress is enabled');
  }

  const sarvamResult = await sarvamService.transcribeBufferedAudio({
    env,
    buffer: bridged.buffer,
    filename: bridged.filename,
    mimeType: bridged.mimeType,
    locale,
    model: profile.stt?.model,
    mode: profile.stt?.mode,
  });

  return {
    ...sarvamResult,
    provider: 'sarvam',
    bridge: {
      inputRateHz: bridged.sampleRateHz,
      sttExtras: bridged.sttExtras,
      flush_signal: bridged.sttExtras.flush_signal,
      turn_detection: bridged.sttExtras.turn_detection,
    },
  };
}

async function synthesizeForTelephony({ text, locale, session, speaker }) {
  const profile = resolveProfile(session);
  const ttsProvider = String(profile.tts?.provider || 'sarvam');

  if (ttsProvider === 'elevenlabs' && elevenlabsService.isElevenLabsConfigured(env)) {
    try {
      const el = await elevenlabsService.synthesizeSpeech({ env, text, profile });
      if (el.mimeType?.includes('mpeg')) {
        logger.warn('[voicePipeline] ElevenLabs returned MP3 — falling back to Sarvam for µ-law telephony (add ffmpeg bridge for MP3 decode)');
      } else {
        return voiceAudioBridge.ttsBufferToTelephonyMulaw(el.buffer, profile);
      }
    } catch (e) {
      logger.warn('[voicePipeline] ElevenLabs TTS failed, using Sarvam', { error: e.message });
    }
  }

  const ttsResult = await sarvamService.synthesizeSpeech({
    env,
    text,
    locale,
    speaker: speaker || process.env.SARVAM_TTS_SPEAKER || 'priya',
    model: profile.tts?.model || 'bulbul:v3',
    speechSampleRate: String(profile.tts?.outputRateHz || 24000),
  });

  return voiceAudioBridge.ttsBufferToTelephonyMulaw(ttsResult.buffer, profile);
}

function getVadConfig(session) {
  const profile = resolveProfile(session);
  return {
    silenceFramesNeeded: Number(profile.vad?.silenceFramesNeeded ?? 5),
    energyThreshold: Number(profile.vad?.energyThreshold ?? 110),
  };
}

function getBargeInConfig(session) {
  const profile = resolveProfile(session);
  const b = profile.bargeIn || {};
  return {
    enabled: b.enabled !== false,
    energyMultiplier: Number(b.energyMultiplier ?? 1.65),
    framesNeeded: Number(b.framesNeeded ?? 4),
    clearTataBuffer: b.clearTataBuffer !== false,
  };
}

module.exports = {
  resolveProfile,
  transcribeTelephonyUtterance,
  synthesizeForTelephony,
  getVadConfig,
  getBargeInConfig,
};
