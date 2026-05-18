/**
 * Implementation artifacts per voice stack profile (system instruction, bridge spec, barge-in handler).
 */
const { PROFILES } = require('../config/voiceStackProfiles');
const voiceAudioBridge = require('./voiceAudioBridge.service');

function buildSystemInstruction(profile) {
  const p = profile;
  return `You are SalesPal's B2B inside-sales voice agent (${p.label}).

CHANNEL: Live Tata Smartflo PSTN call (µ-law 8 kHz). You must sound human, concise, and consultative.

LANGUAGE: Mirror the caller's language (Hinglish, Hindi, English, or regional). Never switch languages unless they do.

KNOWLEDGE: Use Brain Drive / project knowledge boundary for listing facts. Do not invent pricing or inventory.

CONTINUITY: Unified engagement session applies — you already know the lead name, company, last call/WhatsApp summary. Do NOT re-ask "aap ka naam kya hai" on return calls.

PROFILE: ${p.id}
STT: ${p.stt?.provider} @ ${p.stt?.inputRateHz || 16000} Hz
TTS: ${p.tts?.provider} @ ${p.tts?.outputRateHz || 24000} Hz
BRAIN: ${p.brain?.provider}

${p.bestFit || ''}`.trim();
}

function buildBargeInHandlerSpec(profile) {
  const b = profile.bargeIn || {};
  const v = profile.vad || {};
  return {
    description: 'Stop outbound TTS when caller speaks over the bot (critical for natural dialogue).',
    trigger: {
      when: 'session.botSpeaking === true',
      energyAbove: Math.round((v.energyThreshold || 110) * (b.energyMultiplier || 1.65)),
      consecutiveFrames: b.framesNeeded || 4,
      frameDurationMs: 100,
    },
    actions: [
      'send Tata clear event',
      'set botSpeaking = false',
      'reset audio buffer and VAD state',
      'allow new utterance capture',
    ],
    pseudocode: `
if (session.botSpeaking && energy > threshold * ${b.energyMultiplier || 1.65}) {
  bargeInFrames++;
  if (bargeInFrames >= ${b.framesNeeded || 4}) {
    clearTataAudio(session);
    session.botSpeaking = false;
    resetBuffers(session);
  }
}`.trim(),
  };
}

function buildArtifactsForProfile(profileId) {
  const profile = PROFILES[profileId] || PROFILES.india_google_sarvam;
  return {
    profileId: profile.id,
    label: profile.label,
    systemInstruction: buildSystemInstruction(profile),
    websocketBridgeSpec: voiceAudioBridge.describeBridgeSpec(profile),
    bargeInHandler: buildBargeInHandlerSpec(profile),
    contextSeed: profile.contextSeed,
  };
}

function listAllArtifacts() {
  return Object.keys(PROFILES).map((id) => buildArtifactsForProfile(id));
}

module.exports = {
  buildArtifactsForProfile,
  listAllArtifacts,
  buildSystemInstruction,
  buildBargeInHandlerSpec,
};
