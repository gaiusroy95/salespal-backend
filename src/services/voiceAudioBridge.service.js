/**
 * Audio resampling bridge: Tata Smartflo µ-law 8 kHz ↔ per-profile model formats.
 * All PSTN ingress/egress should pass through this module before STT/TTS providers.
 */
const logger = require('../config/logger');
const { TELEPHONY } = require('../config/voiceStackProfiles');

// ─── µ-law codec (telephony leg) ─────────────────────────────────────────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_EXP_TABLE = [0, 132, 396, 924, 1980, 4092, 8316, 16764];

function linearToMulaw(sample) {
  let s = sample;
  const sign = (s >> 8) & 0x80;
  if (sign !== 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinear(mulawByte) {
  const mu = ~mulawByte & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = MULAW_EXP_TABLE[exponent] + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;
  return sample;
}

function mulawBufToPcm16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm.writeInt16LE(mulawToLinear(mulawBuf[i]), i * 2);
  }
  return pcm;
}

function pcm16ToMulawBuf(pcm16Buf) {
  const count = pcm16Buf.length / 2;
  const out = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    out[i] = linearToMulaw(pcm16Buf.readInt16LE(i * 2));
  }
  return out;
}

function resamplePcm16(pcmBuf, srcRate, dstRate) {
  if (srcRate === dstRate) return pcmBuf;
  const srcSamples = pcmBuf.length / 2;
  const dstSamples = Math.max(1, Math.round((srcSamples * dstRate) / srcRate));
  const out = Buffer.alloc(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const srcPos = (i * srcRate) / dstRate;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = idx < srcSamples ? pcmBuf.readInt16LE(idx * 2) : 0;
    const s1 = idx + 1 < srcSamples ? pcmBuf.readInt16LE((idx + 1) * 2) : s0;
    const val = Math.round(s0 + frac * (s1 - s0));
    out.writeInt16LE(Math.max(-32768, Math.min(32767, val)), i * 2);
  }
  return out;
}

function wrapPcm16AsWav(pcmBuf, sampleRate, channels = 1) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuf]);
}

function stripWavHeader(wavBuf) {
  if (wavBuf.length < 44) return { pcm: wavBuf, sampleRate: 24000 };
  const riff = wavBuf.toString('ascii', 0, 4);
  if (riff !== 'RIFF') return { pcm: wavBuf, sampleRate: 24000 };
  const sampleRate = wavBuf.readUInt32LE(24);
  let dataOffset = 12;
  while (dataOffset + 8 < wavBuf.length) {
    const chunkId = wavBuf.toString('ascii', dataOffset, dataOffset + 4);
    const chunkSize = wavBuf.readUInt32LE(dataOffset + 4);
    if (chunkId === 'data') {
      return { pcm: wavBuf.subarray(dataOffset + 8, dataOffset + 8 + chunkSize), sampleRate };
    }
    dataOffset += 8 + chunkSize;
  }
  return { pcm: wavBuf.subarray(44), sampleRate };
}

/**
 * Ingress: Smartflo µ-law 8 kHz → PCM16 WAV at profile STT input rate.
 */
function telephonyMulawToSttWav(mulawBuf, profile) {
  const pcm8k = mulawBufToPcm16(mulawBuf);
  const targetRate = Number(profile?.stt?.inputRateHz || 16000);
  const pcmTarget = targetRate === TELEPHONY.sampleRateHz ? pcm8k : resamplePcm16(pcm8k, TELEPHONY.sampleRateHz, targetRate);
  const wav = wrapPcm16AsWav(pcmTarget, targetRate);
  return {
    buffer: wav,
    mimeType: 'audio/wav',
    filename: 'tata_utterance.wav',
    pcm16: pcmTarget,
    sampleRateHz: targetRate,
    sttExtras: {
      flush_signal: Boolean(profile?.stt?.flushSignal),
      turn_detection: profile?.stt?.turnDetection || null,
      endpointing_ms: profile?.stt?.endpointingMs || null,
    },
  };
}

/**
 * Egress: provider TTS WAV/PCM → µ-law 8 kHz for Tata media events.
 */
function ttsBufferToTelephonyMulaw(ttsBuffer, profile) {
  const telephonyRate = TELEPHONY.sampleRateHz;
  const { pcm, sampleRate } = stripWavHeader(ttsBuffer);
  const targetTtsRate = Number(profile?.tts?.outputRateHz || sampleRate || 24000);
  let pcmWork = pcm;
  let srcRate = sampleRate || targetTtsRate;
  if (srcRate !== telephonyRate) {
    pcmWork = resamplePcm16(pcmWork, srcRate, telephonyRate);
    srcRate = telephonyRate;
  }
  const mulaw = pcm16ToMulawBuf(pcmWork);
  return {
    mulaw,
    durationSec: mulaw.length / telephonyRate,
    pcm16At8k: pcmWork,
  };
}

function describeBridgeSpec(profile) {
  const p = profile || {};
  return {
    telephony: TELEPHONY,
    ingress: {
      from: `${TELEPHONY.encoding} ${TELEPHONY.sampleRateHz}Hz`,
      to: `${p.stt?.inputEncoding || 'pcm16'} ${p.stt?.inputRateHz || 16000}Hz WAV`,
      steps: ['mulaw decode', 'linear resample', 'PCM16 WAV wrap'],
    },
    egress: {
      from: `${p.tts?.outputEncoding || 'pcm16'} ${p.tts?.outputRateHz || 24000}Hz`,
      to: `${TELEPHONY.encoding} ${TELEPHONY.sampleRateHz}Hz`,
      steps: ['strip WAV', 'resample to 8k', 'mulaw encode', '160-byte chunk pad'],
    },
    sttExtras: {
      flush_signal: Boolean(p.stt?.flushSignal),
      turn_detection: p.stt?.turnDetection || null,
      endpointing_ms: p.stt?.endpointingMs || null,
    },
  };
}

function computeEnergy(mulawBuf) {
  if (!mulawBuf?.length) return 0;
  let sum = 0;
  for (let i = 0; i < mulawBuf.length; i++) {
    const s = mulawToLinear(mulawBuf[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / mulawBuf.length);
}

module.exports = {
  TELEPHONY,
  mulawBufToPcm16,
  pcm16ToMulawBuf,
  resamplePcm16,
  wrapPcm16AsWav,
  stripWavHeader,
  telephonyMulawToSttWav,
  ttsBufferToTelephonyMulaw,
  describeBridgeSpec,
  computeEnergy,
  linearToMulaw,
  mulawToLinear,
};
