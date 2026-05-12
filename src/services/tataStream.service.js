/**
 * Tata Smartflo Voice Bot — Bi-directional WebSocket audio streaming.
 *
 * Protocol: https://docs.smartflo.tatatelebusiness.com/docs/bi-directional-audio-streaming-integration-document
 *
 * Inbound from Tata:  audio/x-mulaw 8000 Hz 8-bit mono, base64 in "media" events (every ~100 ms)
 * Outbound to Tata:   audio/x-mulaw 8000 Hz base64 in "media" events (payload must be multiple of 160 bytes)
 *
 * Pipeline per turn:
 *   1. Buffer µ-law chunks until silence detected (VAD) or max buffer reached
 *   2. Decode µ-law → PCM-16 8 kHz → wrap as WAV → Sarvam STT
 *   3. Feed transcript into aiRuntime.handleVoiceTurn (which loads Brain Drive knowledge)
 *   4. Sarvam TTS → WAV (24 kHz PCM-16) → resample to 8 kHz → encode µ-law → stream back
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const logger = require('../config/logger');
const env = require('../config/env');
const sarvamService = require('./sarvam.service');
const aiRuntime = require('./aiRuntime.service');
const db = require('../config/db');

const activeSessions = new Map();

// ─── µ-law codec ────────────────────────────────────────────────────────────

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_EXP_TABLE = [0,132,396,924,1980,4092,8316,16764];

function linearToMulaw(sample) {
  let s = sample;
  const sign = (s >> 8) & 0x80;
  if (sign !== 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (s >> (exponent + 3)) & 0x0F;
  const byte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return byte;
}

function mulawToLinear(mulawByte) {
  const mu = ~mulawByte & 0xFF;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0F;
  let sample = MULAW_EXP_TABLE[exponent] + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;
  return sample;
}

// ─── Audio helpers ──────────────────────────────────────────────────────────

function mulawBufToPcm16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const s = mulawToLinear(mulawBuf[i]);
    pcm.writeInt16LE(s, i * 2);
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

/**
 * Down-sample PCM-16 from srcRate to dstRate using simple linear interpolation.
 * Both rates must be positive integers.
 */
function resamplePcm16(pcmBuf, srcRate, dstRate) {
  if (srcRate === dstRate) return pcmBuf;
  const srcSamples = pcmBuf.length / 2;
  const dstSamples = Math.round((srcSamples * dstRate) / srcRate);
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

/**
 * Strip WAV header and return raw PCM-16 buffer + detected sample rate.
 * Assumes standard 44-byte header (Sarvam Bulbul output).
 */
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

// ─── Voice Activity Detection (energy-based) ────────────────────────────────

const SILENCE_THRESHOLD = 120;
const SILENCE_FRAMES_NEEDED = 7;   // ~700ms of silence → process (natural pause)
const MAX_BUFFER_SECONDS = 15;
const MIN_SPEECH_BYTES = 2400;     // ~300ms of real speech minimum to avoid noise bursts

function computeEnergy(mulawBuf) {
  if (!mulawBuf || !mulawBuf.length) return 0;
  let sum = 0;
  for (let i = 0; i < mulawBuf.length; i++) {
    const s = mulawToLinear(mulawBuf[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / mulawBuf.length);
}

// ─── Session state ──────────────────────────────────────────────────────────

function createStreamSession(streamSid, callSid, meta) {
  return {
    streamSid,
    callSid,
    conversationId: meta.conversationId || null,
    orgId: meta.orgId || null,
    userId: meta.userId || null,
    locale: meta.locale || 'hing',
    detectedLocale: null,
    projectName: meta.projectName || null,
    projectId: meta.projectId || null,
    leadName: meta.leadName || null,
    audioBuffer: [],
    totalBufferedBytes: 0,
    silenceFrameCount: 0,
    isSpeaking: false,
    processing: false,
    botSpeaking: false,
    outChunkCounter: 0,
    openerPlayed: false,
    openerText: meta.openerText || '',
    ws: null,
    closed: false,
    createdAt: Date.now(),
  };
}

/**
 * Detect language from Sarvam STT response or transcript content.
 * Returns a SalesPal locale code (e.g., 'hi', 'en', 'ta') or null.
 */
function detectLanguageFromStt(sttResult, transcript) {
  const langReq = String(sttResult?.language_requested || '').toLowerCase();
  const langDet = String(sttResult?.language_code || sttResult?.detected_language || '').toLowerCase();

  if (langDet && langDet !== 'unknown') {
    const code = langDet.replace(/-.*/, '');
    if (code.length >= 2) return code;
  }

  if (!transcript) return null;
  const t = transcript.toLowerCase();

  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  if (/[\u0B80-\u0BFF]/.test(t)) return 'ta';
  if (/[\u0C00-\u0C7F]/.test(t)) return 'te';
  if (/[\u0C80-\u0CFF]/.test(t)) return 'kn';
  if (/[\u0D00-\u0D7F]/.test(t)) return 'ml';
  if (/[\u0A80-\u0AFF]/.test(t)) return 'gu';
  if (/[\u0980-\u09FF]/.test(t)) return 'bn';
  if (/[\u0A00-\u0A7F]/.test(t)) return 'pa';
  if (/[\u0600-\u06FF]/.test(t)) return /\b(aur|hai|ka|ki|kya|hoon|ye|mein)\b/i.test(t) ? 'ur' : 'ar';
  if (/[\u0E00-\u0E7F]/.test(t)) return 'th';
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(t)) return 'ja';
  if (/[\uAC00-\uD7AF]/.test(t)) return 'ko';
  if (/[\u4E00-\u9FFF]/.test(t)) return 'zh';
  if (/[\u0400-\u04FF]/.test(t)) return 'ru';

  if (/\b(haan|nahi|acha|kya|hai|hoon|kar|mein|aap|kaise)\b/i.test(t)) return 'hing';
  if (/\b(gracias|hola|por favor|bueno|si)\b/i.test(t)) return 'es';
  if (/\b(merci|bonjour|oui|s'il vous|bien)\b/i.test(t)) return 'fr';
  if (/\b(danke|bitte|ja|nein|gut)\b/i.test(t)) return 'de';
  if (/\b(obrigado|sim|n[aã]o|bom)\b/i.test(t)) return 'pt';

  return null;
}

function effectiveLocale(session) {
  return session.detectedLocale || session.locale || 'hing';
}

/**
 * Detect if an STT transcript is likely noise/gibberish rather than real speech.
 * Common patterns: single repeated syllables, very short fragments with no real words,
 * garbled text from phone noise.
 */
function isGibberishTranscript(text) {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 2) return true;

  const words = t.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return true;

  if (words.length === 1 && t.length < 4) return true;

  const repeatedGreetings = /^(hello[.!,\s]*){3,}$/i;
  if (repeatedGreetings.test(t)) return true;

  const onlyFillers = /^[\s,.!?;:'"()…\-–—]+$/;
  if (onlyFillers.test(t)) return true;

  const uniqueChars = new Set(t.toLowerCase().replace(/[^a-z\u0900-\u0D7F]/g, ''));
  if (t.length > 8 && uniqueChars.size <= 3) return true;

  return false;
}

/**
 * Clean text before sending to TTS so the voice sounds natural.
 * Removes URLs, emails, internal labels, code artifacts, and
 * converts abbreviations to spoken form.
 */
function sanitizeTextForTts(text) {
  let t = String(text || '');
  t = t.replace(/https?:\/\/[^\s,)]+/gi, '');
  t = t.replace(/www\.[^\s,)]+/gi, '');
  t = t.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '');
  t = t.replace(/\b(Brain Drive|indexed materials?|source_type|source_name|SalesPal|KNOWLEDGE BOUNDARY|PROJECT KNOWLEDGE|SELECTED PROJECT CONTEXT)\b/gi, '');
  t = t.replace(/\[(website|document|pdf|file|url|excel|csv|text|source)\]/gi, '');
  t = t.replace(/[{}\[\]<>|\\]/g, ' ');
  t = t.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
  t = t.replace(/#{1,6}\s*/g, '');
  t = t.replace(/`[^`]*`/g, '');
  t = t.replace(/\bRs\.?\s*/gi, 'Rupees ');
  t = t.replace(/\bsq\.?\s*ft\.?\b/gi, 'square feet');
  t = t.replace(/\bBHK\b/gi, 'B H K');
  t = t.replace(/\bEMI\b/gi, 'E M I');
  t = t.replace(/\bRERA\b/gi, 'RERA');
  t = t.replace(/\n{2,}/g, '. ');
  t = t.replace(/\n/g, ', ');
  t = t.replace(/\s{2,}/g, ' ');
  t = t.replace(/[—–]{2,}/g, ', ');
  return t.trim();
}

// ─── Core pipeline ──────────────────────────────────────────────────────────

async function processUtterance(session) {
  if (session.processing || session.closed) return;
  if (session.totalBufferedBytes < MIN_SPEECH_BYTES) {
    logger.debug('[tataStream] Too little audio, discarding', {
      streamSid: session.streamSid,
      bytes: session.totalBufferedBytes,
      minRequired: MIN_SPEECH_BYTES,
    });
    session.audioBuffer = [];
    session.totalBufferedBytes = 0;
    return;
  }
  session.processing = true;
  const pipelineStartMs = Date.now();
  const audioChunks = session.audioBuffer.splice(0);
  session.totalBufferedBytes = 0;
  session.silenceFrameCount = 0;

  try {
    const mulawFull = Buffer.concat(audioChunks);
    const pcm16_8k = mulawBufToPcm16(mulawFull);
    const wavBuf = wrapPcm16AsWav(pcm16_8k, 8000);

    const currentLocale = effectiveLocale(session);
    logger.info('[tataStream] STT start', {
      streamSid: session.streamSid,
      audioBytes: mulawFull.length,
      durationSec: (mulawFull.length / 8000).toFixed(1),
      locale: currentLocale,
    });

    const sttStartMs = Date.now();
    const sttResult = await sarvamService.transcribeBufferedAudio({
      env,
      buffer: wavBuf,
      filename: 'tata_utterance.wav',
      mimeType: 'audio/wav',
      locale: currentLocale,
    });
    const sttMs = Date.now() - sttStartMs;

    const transcript = String(sttResult?.transcript || '').trim();
    if (!transcript) {
      logger.info('[tataStream] Empty transcript — skipping AI turn', {
        streamSid: session.streamSid,
        sttMs,
      });
      session.processing = false;
      return;
    }

    if (isGibberishTranscript(transcript)) {
      logger.info('[tataStream] Gibberish/noise transcript — discarding', {
        streamSid: session.streamSid,
        transcript: transcript.slice(0, 120),
        sttMs,
      });
      session.processing = false;
      return;
    }

    const newLocale = detectLanguageFromStt(sttResult, transcript);
    if (newLocale && newLocale !== session.detectedLocale) {
      const prev = session.detectedLocale || session.locale;
      session.detectedLocale = newLocale;
      logger.info('[tataStream] Language switched', {
        streamSid: session.streamSid,
        from: prev,
        to: newLocale,
        transcript: transcript.slice(0, 80),
      });
    }

    logger.info('[tataStream] STT result', {
      streamSid: session.streamSid,
      transcript: transcript.slice(0, 200),
      locale: effectiveLocale(session),
      sttMs,
    });

    if (!session.conversationId) {
      logger.warn('[tataStream] No conversationId — cannot process AI turn', { streamSid: session.streamSid });
      session.processing = false;
      return;
    }

    const aiStartMs = Date.now();
    const turnResult = await aiRuntime.handleVoiceTurn({
      conversationId: session.conversationId,
      text: transcript,
      orgId: session.orgId,
      userId: session.userId,
      detectedLocale: effectiveLocale(session),
    });
    const aiMs = Date.now() - aiStartMs;

    const reply = String(turnResult?.reply || '').trim();
    if (!reply) {
      logger.warn('[tataStream] AI returned empty reply', { streamSid: session.streamSid, aiMs });
      session.processing = false;
      return;
    }

    logger.info('[tataStream] AI reply', {
      streamSid: session.streamSid,
      reply: reply.slice(0, 200),
      aiMs,
    });

    await streamTtsToTata(session, reply);

    const totalMs = Date.now() - pipelineStartMs;
    logger.info('[tataStream] Pipeline complete', {
      streamSid: session.streamSid,
      sttMs,
      aiMs,
      totalMs,
      transcript: transcript.slice(0, 60),
      reply: reply.slice(0, 60),
    });
  } catch (err) {
    logger.error('[tataStream] Pipeline error', {
      streamSid: session.streamSid,
      error: err.message,
      stack: err.stack?.slice(0, 400),
    });
  } finally {
    session.processing = false;
  }
}

async function streamTtsToTata(session, rawText) {
  if (session.closed) {
    logger.warn('[tataStream] streamTtsToTata: session closed, skipping', { streamSid: session.streamSid });
    return;
  }
  if (!session.ws) {
    logger.warn('[tataStream] streamTtsToTata: no ws object, skipping', { streamSid: session.streamSid });
    return;
  }
  if (session.ws.readyState !== 1) {
    logger.warn('[tataStream] streamTtsToTata: ws not OPEN', {
      streamSid: session.streamSid,
      readyState: session.ws.readyState,
    });
    return;
  }

  const text = sanitizeTextForTts(rawText);
  if (!text) {
    logger.warn('[tataStream] streamTtsToTata: text empty after sanitization', { streamSid: session.streamSid });
    return;
  }

  try {
    session.botSpeaking = true;
    const ttsLocale = effectiveLocale(session);
    const ttsStartMs = Date.now();
    logger.info('[tataStream] TTS synthesis starting', {
      streamSid: session.streamSid,
      textLen: text.length,
      locale: ttsLocale,
    });
    const ttsResult = await sarvamService.synthesizeSpeech({
      env,
      text,
      locale: ttsLocale,
      speaker: process.env.SARVAM_TTS_SPEAKER || 'priya',
      model: 'bulbul:v3',
      speechSampleRate: '22050',
    });

    logger.info('[tataStream] TTS synthesis done', {
      streamSid: session.streamSid,
      wavBytes: ttsResult.buffer?.length || 0,
      ttsMs: Date.now() - ttsStartMs,
    });

    let pcm8k;
    const { pcm, sampleRate } = stripWavHeader(ttsResult.buffer);
    if (sampleRate !== 8000) {
      pcm8k = resamplePcm16(pcm, sampleRate, 8000);
    } else {
      pcm8k = pcm;
    }

    const mulawOut = pcm16ToMulawBuf(pcm8k);

    logger.info('[tataStream] Audio encoded', {
      streamSid: session.streamSid,
      pcmBytes: pcm8k.length,
      mulawBytes: mulawOut.length,
      durationSec: (mulawOut.length / 8000).toFixed(1),
      srcRate: sampleRate,
    });

    const CHUNK_SIZE = 3200;
    for (let offset = 0; offset < mulawOut.length; offset += CHUNK_SIZE) {
      if (session.closed || !session.botSpeaking) break;
      let chunk = mulawOut.subarray(offset, offset + CHUNK_SIZE);
      const remainder = chunk.length % 160;
      if (remainder !== 0) {
        const padded = Buffer.alloc(chunk.length + (160 - remainder), 0xFF);
        chunk.copy(padded);
        chunk = padded;
      }

      session.outChunkCounter++;
      const msg = JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: {
          payload: chunk.toString('base64'),
          chunk: session.outChunkCounter,
        },
      });

      if (session.ws?.readyState === 1) {
        session.ws.send(msg);
      }
    }

    const chunksSent = session.outChunkCounter;
    const markName = `reply_${Date.now()}`;
    if (session.ws?.readyState === 1) {
      session.ws.send(JSON.stringify({
        event: 'mark',
        streamSid: session.streamSid,
        mark: { name: markName },
      }));
    }

    const audioDurationSec = mulawOut.length / 8000;
    logger.info('[tataStream] TTS audio streamed to Tata', {
      streamSid: session.streamSid,
      textLen: text.length,
      mulawBytes: mulawOut.length,
      durationSec: audioDurationSec.toFixed(1),
      chunksSent,
      wsOpen: session.ws?.readyState === 1,
      ttsMs: Date.now() - ttsStartMs,
    });

    const playbackWaitMs = Math.max(0, Math.round(audioDurationSec * 1000) - 500);
    const POLL_INTERVAL = 100;
    let waited = 0;
    while (waited < playbackWaitMs && session.botSpeaking && !session.closed) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      waited += POLL_INTERVAL;
    }
    session.botSpeaking = false;
    session._bargeInFrames = 0;
  } catch (err) {
    session.botSpeaking = false;
    logger.error('[tataStream] TTS streaming failed', {
      streamSid: session.streamSid,
      error: err.message,
    });
  }
}

function clearTataAudio(session) {
  if (session.closed || !session.ws || session.ws.readyState !== 1) return;
  session.ws.send(JSON.stringify({
    event: 'clear',
    streamSid: session.streamSid,
  }));
}

// ─── WebSocket handler ──────────────────────────────────────────────────────

function handleTataConnection(ws, req) {
  const connId = crypto.randomUUID().slice(0, 8);
  let session = null;

  logger.info('[tataStream] WebSocket connected', { connId, url: req.url });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      logger.warn('[tataStream] Non-JSON message', { connId });
      return;
    }

    const event = String(msg.event || '').toLowerCase();

    switch (event) {
      case 'connected': {
        logger.info('[tataStream] Handshake received (Tata confirmed connection)', { connId, url: req.url?.slice(0, 200) });
        break;
      }

      case 'start': {
        const startData = msg.start || {};
        const streamSid = startData.streamSid || msg.streamSid || connId;
        const callSid = startData.callSid || '';
        const customParams = startData.customParameters || {};
        const direction = String(startData.direction || '').toLowerCase();
        const startFrom = String(startData.from || '').replace(/[^\d]/g, '');
        const startTo = String(startData.to || '').replace(/[^\d]/g, '');

        let meta = parseSessionMeta(customParams, req);

        logger.info('[tataStream] START event received', {
          connId, streamSid, callSid, direction,
          startFrom: startFrom.slice(-4) || '(empty)',
          startTo: startTo.slice(-4) || '(empty)',
          hasConversationId: Boolean(meta.conversationId),
          hasOpener: Boolean(meta.openerText),
          hasOrgId: Boolean(meta.orgId),
          urlCallerNumber: meta.callerNumber || '(empty)',
          urlCalledNumber: meta.calledNumber || '(empty)',
          customParamKeys: Object.keys(customParams || {}),
          customParamRaw: JSON.stringify(customParams).slice(0, 300),
        });

        const customerPhone =
          direction === 'outbound' ? (startTo || meta.calledNumber) :
          direction === 'inbound' ? (startFrom || meta.callerNumber) :
          (startTo || startFrom || meta.calledNumber || meta.callerNumber);

        if (!meta.conversationId && customerPhone) {
          logger.info('[tataStream] No conversationId from params — looking up by customer phone', {
            streamSid, customerPhone: customerPhone.slice(-4), direction,
          });
          const phoneLookup = await lookupSessionByPhone(customerPhone);
          if (phoneLookup) {
            logger.info('[tataStream] Found session by phone', {
              streamSid,
              conversationId: phoneLookup.conversation_id,
            });
            const dbCtx = await loadSessionContext(phoneLookup.conversation_id);
            if (dbCtx) {
              meta = { ...meta, ...dbCtx };
            }
          } else {
            logger.warn('[tataStream] No session found by phone', {
              streamSid, customerPhone: customerPhone.slice(-4),
            });
          }
        }

        if (meta.conversationId && !meta.openerText) {
          logger.info('[tataStream] Have conversationId but no opener — loading from DB', {
            streamSid, conversationId: meta.conversationId,
          });
          const dbCtx = await loadSessionContext(meta.conversationId);
          if (dbCtx) {
            if (!meta.openerText && dbCtx.openerText) meta.openerText = dbCtx.openerText;
            if (!meta.orgId && dbCtx.orgId) meta.orgId = dbCtx.orgId;
            if (!meta.userId && dbCtx.userId) meta.userId = dbCtx.userId;
            if (!meta.projectName && dbCtx.projectName) meta.projectName = dbCtx.projectName;
            if (!meta.projectId && dbCtx.projectId) meta.projectId = dbCtx.projectId;
            if (!meta.leadName && dbCtx.leadName) meta.leadName = dbCtx.leadName;
            logger.info('[tataStream] Enriched from DB', {
              streamSid,
              hasOpener: Boolean(meta.openerText),
              openerLen: meta.openerText?.length || 0,
              projectName: meta.projectName || '(none)',
            });
          }
        }

        session = createStreamSession(streamSid, callSid, meta);
        session.ws = ws;
        session.direction = direction;
        session.customerPhone = customerPhone || '';
        activeSessions.set(streamSid, session);

        logger.info('[tataStream] Session created', {
          streamSid, callSid, direction,
          conversationId: session.conversationId || '(none)',
          projectName: session.projectName || '(none)',
          hasOpener: Boolean(session.openerText),
          openerLen: session.openerText?.length || 0,
          openerPreview: session.openerText ? session.openerText.slice(0, 80) : '(empty)',
        });

        if (session.conversationId && session.openerText) {
          setTimeout(async () => {
            if (session.closed) return;
            try {
              logger.info('[tataStream] Sending opener TTS to caller', {
                streamSid,
                textLen: session.openerText.length,
                text: session.openerText.slice(0, 120),
                wsReady: session.ws?.readyState === 1,
              });
              await streamTtsToTata(session, session.openerText);
              session.openerPlayed = true;
              logger.info('[tataStream] Opener TTS delivered OK', { streamSid });
            } catch (e) {
              logger.error('[tataStream] Opener TTS FAILED', {
                streamSid,
                error: e.message,
                stack: e.stack?.slice(0, 400),
              });
            }
          }, 600);
        } else if (session.conversationId && !session.openerText) {
          logger.warn('[tataStream] Session exists but NO opener text — bot will wait for caller to speak', { streamSid });
        } else {
          logger.warn('[tataStream] No conversationId — bot has no context', { streamSid, direction });
        }
        break;
      }

      case 'media': {
        if (!session) break;
        const payload = msg.media?.payload;
        if (!payload) break;

        if (!session._mediaFrameCount) session._mediaFrameCount = 0;
        session._mediaFrameCount++;

        if (session.botSpeaking) {
          const energy = computeEnergy(Buffer.from(payload, 'base64'));
          if (energy > SILENCE_THRESHOLD * 1.5) {
            if (!session._bargeInFrames) session._bargeInFrames = 0;
            session._bargeInFrames++;
            if (session._bargeInFrames >= 3) {
              logger.info('[tataStream] Barge-in detected — stopping bot speech', {
                streamSid: session.streamSid,
                energy: Math.round(energy),
                frame: session._mediaFrameCount,
              });
              clearTataAudio(session);
              session.botSpeaking = false;
              session._bargeInFrames = 0;
              session.audioBuffer = [];
              session.totalBufferedBytes = 0;
              session.isSpeaking = false;
              session.silenceFrameCount = 0;
            }
          } else {
            session._bargeInFrames = 0;
          }
          if (session.botSpeaking) break;
        }

        const audioBuf = Buffer.from(payload, 'base64');
        const energy = computeEnergy(audioBuf);

        if (session._mediaFrameCount <= 3 || session._mediaFrameCount % 200 === 0) {
          logger.info('[tataStream] Media frame', {
            streamSid: session.streamSid,
            frame: session._mediaFrameCount,
            energy: Math.round(energy),
            threshold: SILENCE_THRESHOLD,
            isSpeaking: session.isSpeaking,
            processing: session.processing,
            botSpeaking: session.botSpeaking,
            bufferedBytes: session.totalBufferedBytes,
          });
        }

        if (energy > SILENCE_THRESHOLD) {
          if (session.processing) {
            clearTataAudio(session);
            session.processing = false;
          }
          if (!session.isSpeaking) {
            logger.info('[tataStream] Human speech detected', {
              streamSid: session.streamSid,
              energy: Math.round(energy),
              frame: session._mediaFrameCount,
            });
          }
          session.isSpeaking = true;
          session.silenceFrameCount = 0;
          session.audioBuffer.push(audioBuf);
          session.totalBufferedBytes += audioBuf.length;
        } else if (session.isSpeaking) {
          session.silenceFrameCount++;
          session.audioBuffer.push(audioBuf);
          session.totalBufferedBytes += audioBuf.length;

          if (session.silenceFrameCount >= SILENCE_FRAMES_NEEDED) {
            logger.info('[tataStream] Human paused — processing utterance', {
              streamSid: session.streamSid,
              bufferedBytes: session.totalBufferedBytes,
              durationSec: (session.totalBufferedBytes / 8000).toFixed(1),
              silenceMs: SILENCE_FRAMES_NEEDED * 100,
              frame: session._mediaFrameCount,
            });
            session.isSpeaking = false;
            session.silenceFrameCount = 0;
            processUtterance(session);
          }
        }

        if (session.totalBufferedBytes > MAX_BUFFER_SECONDS * 8000) {
          logger.info('[tataStream] Max buffer reached — forcing processing', {
            streamSid: session.streamSid,
            bufferedBytes: session.totalBufferedBytes,
          });
          session.isSpeaking = false;
          processUtterance(session);
        }
        break;
      }

      case 'stop': {
        const reason = msg.stop?.reason || 'unknown';
        logger.info('[tataStream] Stream stopped', {
          streamSid: session?.streamSid || msg.streamSid,
          reason,
        });
        if (session) {
          session.closed = true;
          activeSessions.delete(session.streamSid);
        }
        break;
      }

      case 'dtmf': {
        logger.info('[tataStream] DTMF received', {
          streamSid: session?.streamSid,
          digit: msg.dtmf?.digit,
        });
        break;
      }

      case 'mark': {
        logger.debug('[tataStream] Mark received', {
          streamSid: session?.streamSid,
          name: msg.mark?.name,
        });
        break;
      }

      default: {
        logger.debug('[tataStream] Unknown event', { connId, event });
      }
    }
  });

  ws.on('close', (code) => {
    logger.info('[tataStream] WebSocket closed', { connId, code, streamSid: session?.streamSid });
    if (session) {
      session.closed = true;
      activeSessions.delete(session.streamSid);
    }
  });

  ws.on('error', (err) => {
    logger.error('[tataStream] WebSocket error', { connId, error: err.message });
    if (session) {
      session.closed = true;
      activeSessions.delete(session.streamSid);
    }
  });
}

/**
 * Extract session metadata from Smartflo customParameters or query string.
 * The custom_identifier JSON (set during click_to_call_support) may arrive:
 *   1. In customParameters object (decoded)
 *   2. In customParameters.custom_identifier (stringified JSON)
 *   3. In the WebSocket connection URL query parameters
 * We try all sources and merge.
 */
function parseSessionMeta(customParams, req) {
  let cid = {};

  if (customParams && typeof customParams === 'object') {
    if (typeof customParams.custom_identifier === 'string') {
      try { cid = JSON.parse(customParams.custom_identifier); } catch { cid = customParams; }
    } else {
      cid = { ...customParams };
    }
  } else if (typeof customParams === 'string') {
    try { cid = JSON.parse(customParams); } catch { cid = {}; }
    if (typeof cid === 'string') {
      try { cid = JSON.parse(cid); } catch { cid = {}; }
    }
  }

  const url = new URL(req.url || '/', `wss://${req.headers.host || 'localhost'}`);
  const qConvId = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id') || '';
  const qOrgId = url.searchParams.get('orgId') || url.searchParams.get('org_id') || '';
  const qUserId = url.searchParams.get('userId') || url.searchParams.get('user_id') || '';

  const conversationId = cid.salespal_conversation_id || cid.conversationId || qConvId || '';
  const orgId = cid.orgId || cid.org_id || qOrgId || null;
  const userId = cid.userId || cid.user_id || qUserId || null;
  const locale = cid.locale || url.searchParams.get('locale') || 'hing';
  const projectName = cid.project_name || cid.projectName || '';
  const projectId = cid.project_id || cid.projectId || '';
  const openerText = cid.opener || '';
  const leadName = cid.lead_name || cid.leadName || '';
  const callerNumber = url.searchParams.get('fromNumber') || url.searchParams.get('from') || '';
  const calledNumber = url.searchParams.get('toNumber') || url.searchParams.get('to') || '';

  return { conversationId, orgId, userId, locale, projectName, projectId, openerText, leadName, callerNumber, calledNumber };
}

/**
 * Attempt to find an existing voice session from the database
 * when custom_identifier doesn't carry conversationId.
 * Looks up by customer phone number for the most recent live session.
 * Tries multiple phone formats (with/without country code).
 */
async function lookupSessionByPhone(phoneDigits) {
  if (!phoneDigits || phoneDigits.length < 8) return null;

  const ownNumber = String(env.telephony?.fromNumber || process.env.TATA_CALL_FROM_NUMBER || '').replace(/[^\d]/g, '');
  if (ownNumber && phoneDigits.endsWith(ownNumber.slice(-10))) {
    logger.info('[tataStream] lookupSessionByPhone: skipping — phone matches bot number', {
      phone: phoneDigits.slice(-4),
    });
    return null;
  }

  const suffixes = [phoneDigits];
  if (phoneDigits.startsWith('91') && phoneDigits.length === 12) suffixes.push(phoneDigits.slice(2));
  if (phoneDigits.length === 10) suffixes.push(`91${phoneDigits}`);

  for (const suffix of suffixes) {
    try {
      const { rows } = await db.query(
        `SELECT conversation_id, org_id, user_id, locale, metadata, contact_name
         FROM ai_voice_sessions
         WHERE contact_phone LIKE $1
           AND state = 'live'
           AND created_at > NOW() - INTERVAL '30 minutes'
         ORDER BY created_at DESC
         LIMIT 1`,
        [`%${suffix.slice(-10)}`]
      );
      if (rows[0]) {
        logger.info('[tataStream] lookupSessionByPhone: FOUND', {
          phone: suffix.slice(-4),
          conversationId: rows[0].conversation_id,
        });
        return rows[0];
      }
    } catch (e) {
      logger.warn('[tataStream] Phone lookup query failed', { error: e.message, suffix: suffix.slice(-4) });
    }
  }
  logger.info('[tataStream] lookupSessionByPhone: no match', { phone: phoneDigits.slice(-4) });
  return null;
}

/**
 * Attempt to load opener text and project context from a voice session in DB
 * when the WebSocket custom_identifier didn't carry it.
 */
async function loadSessionContext(conversationId) {
  if (!conversationId) return null;
  try {
    const { rows } = await db.query(
      `SELECT conversation_id, org_id, user_id, locale, contact_name, metadata FROM ai_voice_sessions WHERE conversation_id = $1`,
      [conversationId]
    );
    if (!rows[0]) return null;
    const row = rows[0];
    const md = (typeof row.metadata === 'object' && row.metadata) ? row.metadata : {};

    const { rows: turnRows } = await db.query(
      `SELECT content FROM ai_voice_turns WHERE conversation_id = $1 AND role = 'assistant' ORDER BY created_at ASC LIMIT 1`,
      [conversationId]
    );
    const opener = turnRows[0]?.content || '';

    return {
      conversationId: row.conversation_id,
      orgId: row.org_id,
      userId: row.user_id,
      locale: row.locale || 'hing',
      projectName: md.voiceProjectName || '',
      projectId: md.projectId || '',
      openerText: opener,
      leadName: row.contact_name || '',
    };
  } catch (e) {
    logger.warn('[tataStream] loadSessionContext failed', { conversationId, error: e.message });
    return null;
  }
}

// ─── Dynamic endpoint handler ───────────────────────────────────────────────

function buildWssUrl(req) {
  const configured = String(env.telephony?.voiceBotWssUrl || process.env.TATA_VOICE_BOT_WSS_URL || '').trim();
  if (configured) return configured;

  const backendUrl = String(
    env.telephony?.statusWebhookUrl ||
    process.env.TATA_CALL_STATUS_WEBHOOK_URL ||
    ''
  ).trim();

  if (backendUrl) {
    try {
      const u = new URL(backendUrl);
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${u.host}/ws/tata-voice`;
    } catch {}
  }

  const host = req?.headers?.host || 'localhost';
  const proto = req?.secure || req?.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  return `${proto}://${host}/ws/tata-voice`;
}

/**
 * POST /webhooks/tata/voice-stream-resolve
 * Smartflo Dynamic Endpoint — must respond within 2000 ms with { success, wss_url }.
 * Also parses custom_identifier from the request body so we can pass context via URL query
 * (as backup when Tata doesn't forward customParameters in the WebSocket start event).
 */
function handleVoiceStreamResolve(req, res) {
  try {
    const body = req.body || {};
    const { callId, fromNumber, toNumber, custom_identifier } = body;
    const baseWss = buildWssUrl(req);
    const params = new URLSearchParams();
    if (callId) params.set('callId', callId);
    if (fromNumber) params.set('fromNumber', fromNumber);
    if (toNumber) params.set('toNumber', toNumber);

    let cid = {};
    if (custom_identifier) {
      try {
        cid = typeof custom_identifier === 'string' ? JSON.parse(custom_identifier) : custom_identifier;
      } catch { cid = {}; }
    }
    if (cid.salespal_conversation_id) params.set('conversationId', cid.salespal_conversation_id);
    if (cid.orgId) params.set('orgId', cid.orgId);
    if (cid.userId) params.set('userId', cid.userId);
    if (cid.locale) params.set('locale', cid.locale);

    const sep = baseWss.includes('?') ? '&' : '?';
    const wss_url = params.toString() ? `${baseWss}${sep}${params.toString()}` : baseWss;

    logger.info('[tataStream] Dynamic endpoint resolved', {
      callId,
      fromNumber: fromNumber?.slice(-4) || '',
      hasCustomId: Boolean(custom_identifier),
      hasConvId: Boolean(cid.salespal_conversation_id),
      wss_url: wss_url.slice(0, 200),
    });

    return res.status(200).json({ success: true, wss_url });
  } catch (err) {
    logger.error('[tataStream] Dynamic endpoint error', { error: err.message });
    return res.status(200).json({ success: true, wss_url: buildWssUrl(req) });
  }
}

// ─── WebSocket server bootstrap ─────────────────────────────────────────────

let wssInstance = null;

function attachWebSocketServer(httpServer) {
  wssInstance = new WebSocketServer({
    server: httpServer,
    path: '/ws/tata-voice',
    maxPayload: 1024 * 1024,
  });

  wssInstance.on('connection', handleTataConnection);
  wssInstance.on('error', (err) => {
    logger.error('[tataStream] WSS error', { error: err.message });
  });

  logger.info('[tataStream] WebSocket server attached at /ws/tata-voice');
  return wssInstance;
}

function getActiveSessionCount() {
  return activeSessions.size;
}

module.exports = {
  attachWebSocketServer,
  handleVoiceStreamResolve,
  buildWssUrl,
  getActiveSessionCount,
};
