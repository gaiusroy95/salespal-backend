/**
 * B2B sales bot voice stack profiles (Tata µ-law 8 kHz telephony → model-specific audio).
 * Set VOICE_STACK_PROFILE to one of these ids (default: india_google_sarvam).
 */
const TELEPHONY = Object.freeze({
  encoding: 'mulaw',
  sampleRateHz: 8000,
  frameMs: 100,
  chunkBytes: 160,
});

const PROFILES = Object.freeze({
  global_google_default: {
    id: 'global_google_default',
    label: 'Vertex Gemini Live',
    tag: 'Vertex AI',
    telephony: TELEPHONY,
    stt: {
      provider: 'gemini_live',
      inputEncoding: 'pcm16',
      inputRateHz: 16000,
    },
    tts: {
      provider: 'gemini_live',
      outputEncoding: 'pcm16',
      outputRateHz: 24000,
    },
    brain: { provider: 'vertex_gemini_live' },
    contextSeed: {
      method: 'send_client_content',
      beforeFirstAudio: true,
      includeEngagementSession: true,
      includeVoiceTurnHistory: true,
      forbidReaskingName: true,
    },
    vad: {
      mode: 'server',
      silenceFramesNeeded: 5,
      energyThreshold: 110,
    },
    bargeIn: {
      enabled: true,
      energyMultiplier: 1.65,
      framesNeeded: 3,
      clearTataBuffer: true,
    },
    bestFit: 'Outbound English, enterprise accounts, MVP on Vertex-native stack.',
  },

  india_google_sarvam: {
    id: 'india_google_sarvam',
    label: 'Vertex brain + Sarvam Indic',
    tag: 'Indic-first',
    telephony: TELEPHONY,
    stt: {
      provider: 'sarvam',
      inputEncoding: 'pcm16',
      inputRateHz: 16000,
      flushSignal: true,
      turnDetection: 'stt',
      model: 'saaras:v3',
      mode: 'codemix',
    },
    tts: {
      provider: 'sarvam',
      outputEncoding: 'pcm16',
      outputRateHz: 24000,
      model: 'bulbul:v3',
    },
    brain: { provider: 'vertex_gemini_text', sttTtsBridge: true },
    contextSeed: {
      method: 'prompt_injection',
      beforeFirstAudio: true,
      includeEngagementSession: true,
      includeVoiceTurnHistory: true,
      forbidReaskingName: true,
    },
    vad: {
      mode: 'stt_assisted',
      silenceFramesNeeded: 5,
      energyThreshold: 110,
    },
    bargeIn: {
      enabled: true,
      energyMultiplier: 1.65,
      framesNeeded: 4,
      clearTataBuffer: true,
    },
    bestFit: 'Hinglish discovery, regional leads, Tier 2/3 outreach (current production default).',
  },

  fast_realtime_deepgram: {
    id: 'fast_realtime_deepgram',
    label: 'Deepgram Nova STT + bridge TTS',
    tag: 'STT-only',
    telephony: TELEPHONY,
    stt: {
      provider: 'deepgram',
      inputEncoding: 'pcm16',
      inputRateHz: 16000,
      model: 'nova-2',
      endpointingMs: 300,
      language: 'hi',
    },
    tts: {
      provider: 'sarvam',
      outputEncoding: 'pcm16',
      outputRateHz: 24000,
    },
    brain: { provider: 'vertex_gemini_text' },
    contextSeed: {
      method: 'prompt_injection',
      beforeFirstAudio: true,
      includeEngagementSession: true,
      forbidReaskingName: true,
    },
    vad: {
      mode: 'endpointing',
      silenceFramesNeeded: 4,
      energyThreshold: 100,
    },
    bargeIn: {
      enabled: true,
      energyMultiplier: 1.5,
      framesNeeded: 2,
      clearTataBuffer: true,
    },
    bestFit: 'High-volume outbound, rapid qualification, barge-in-heavy calls.',
  },

  premium_voice_elevenlabs: {
    id: 'premium_voice_elevenlabs',
    label: 'Sarvam STT + ElevenLabs TTS',
    tag: 'TTS-only',
    telephony: TELEPHONY,
    stt: {
      provider: 'sarvam',
      inputEncoding: 'pcm16',
      inputRateHz: 16000,
      model: 'saaras:v3',
      mode: 'codemix',
    },
    tts: {
      provider: 'elevenlabs',
      outputEncoding: 'pcm16',
      outputRateHz: 24000,
      model: 'eleven_turbo_v2_5',
    },
    brain: { provider: 'vertex_gemini_text' },
    contextSeed: {
      method: 'prompt_injection',
      beforeFirstAudio: true,
      includeEngagementSession: true,
      forbidReaskingName: true,
    },
    vad: {
      mode: 'stt_assisted',
      silenceFramesNeeded: 5,
      energyThreshold: 110,
    },
    bargeIn: {
      enabled: true,
      energyMultiplier: 1.7,
      framesNeeded: 4,
      clearTataBuffer: true,
    },
    bestFit: 'L3 escalation, HNI leads, senior AI persona, brand-sensitive touchpoints.',
  },
});

const PROFILE_IDS = Object.keys(PROFILES);

function resolveVoiceStackProfile(profileId) {
  const key = String(profileId || process.env.VOICE_STACK_PROFILE || 'india_google_sarvam')
    .trim()
    .toLowerCase();
  return PROFILES[key] || PROFILES.india_google_sarvam;
}

function listVoiceStackProfiles() {
  return PROFILE_IDS.map((id) => {
    const p = PROFILES[id];
    return {
      id: p.id,
      label: p.label,
      tag: p.tag,
      bestFit: p.bestFit,
      sttProvider: p.stt.provider,
      ttsProvider: p.tts.provider,
      brainProvider: p.brain.provider,
      telephony: p.telephony,
    };
  });
}

module.exports = {
  TELEPHONY,
  PROFILES,
  PROFILE_IDS,
  resolveVoiceStackProfile,
  listVoiceStackProfiles,
};
