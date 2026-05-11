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

const SILENCE_THRESHOLD = 350;
const SILENCE_FRAMES_NEEDED = 12;
const MAX_BUFFER_SECONDS = 15;
const MIN_SPEECH_BYTES = 1600;

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
    projectName: meta.projectName || null,
    audioBuffer: [],
    totalBufferedBytes: 0,
    silenceFrameCount: 0,
    isSpeaking: false,
    processing: false,
    outChunkCounter: 0,
    openerPlayed: false,
    openerText: meta.openerText || '',
    ws: null,
    closed: false,
    createdAt: Date.now(),
  };
}

// ─── Core pipeline ──────────────────────────────────────────────────────────

async function processUtterance(session) {
  if (session.processing || session.closed) return;
  if (session.totalBufferedBytes < MIN_SPEECH_BYTES) {
    session.audioBuffer = [];
    session.totalBufferedBytes = 0;
    return;
  }
  session.processing = true;
  const audioChunks = session.audioBuffer.splice(0);
  session.totalBufferedBytes = 0;
  session.silenceFrameCount = 0;

  try {
    const mulawFull = Buffer.concat(audioChunks);
    const pcm16_8k = mulawBufToPcm16(mulawFull);
    const wavBuf = wrapPcm16AsWav(pcm16_8k, 8000);

    logger.info('[tataStream] STT start', {
      streamSid: session.streamSid,
      audioBytes: mulawFull.length,
      durationSec: (mulawFull.length / 8000).toFixed(1),
    });

    const sttResult = await sarvamService.transcribeBufferedAudio({
      env,
      buffer: wavBuf,
      filename: 'tata_utterance.wav',
      mimeType: 'audio/wav',
      locale: session.locale,
    });

    const transcript = String(sttResult?.transcript || '').trim();
    if (!transcript) {
      logger.info('[tataStream] Empty transcript — skipping AI turn', { streamSid: session.streamSid });
      session.processing = false;
      return;
    }

    logger.info('[tataStream] STT result', { streamSid: session.streamSid, transcript: transcript.slice(0, 200) });

    const turnResult = await aiRuntime.handleVoiceTurn({
      conversationId: session.conversationId,
      text: transcript,
      orgId: session.orgId,
      userId: session.userId,
    });

    const reply = String(turnResult?.reply || '').trim();
    if (!reply) {
      logger.warn('[tataStream] AI returned empty reply', { streamSid: session.streamSid });
      session.processing = false;
      return;
    }

    logger.info('[tataStream] AI reply', { streamSid: session.streamSid, reply: reply.slice(0, 200) });

    await streamTtsToTata(session, reply);
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

async function streamTtsToTata(session, text) {
  if (session.closed || !session.ws) return;

  try {
    const ttsResult = await sarvamService.synthesizeSpeech({
      env,
      text,
      locale: session.locale,
      speechSampleRate: '8000',
    });

    let pcm8k;
    const { pcm, sampleRate } = stripWavHeader(ttsResult.buffer);
    if (sampleRate !== 8000) {
      pcm8k = resamplePcm16(pcm, sampleRate, 8000);
    } else {
      pcm8k = pcm;
    }

    const mulawOut = pcm16ToMulawBuf(pcm8k);

    const CHUNK_SIZE = 3200;
    for (let offset = 0; offset < mulawOut.length; offset += CHUNK_SIZE) {
      if (session.closed) break;
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

    const markName = `reply_${Date.now()}`;
    if (session.ws?.readyState === 1) {
      session.ws.send(JSON.stringify({
        event: 'mark',
        streamSid: session.streamSid,
        mark: { name: markName },
      }));
    }

    logger.info('[tataStream] TTS streamed', {
      streamSid: session.streamSid,
      textLen: text.length,
      mulawBytes: mulawOut.length,
      durationSec: (mulawOut.length / 8000).toFixed(1),
    });
  } catch (err) {
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
        logger.info('[tataStream] Handshake received', { connId });
        break;
      }

      case 'start': {
        const startData = msg.start || {};
        const streamSid = startData.streamSid || msg.streamSid || connId;
        const callSid = startData.callSid || '';
        const customParams = startData.customParameters || {};

        const meta = parseSessionMeta(customParams, req);

        session = createStreamSession(streamSid, callSid, meta);
        session.ws = ws;
        activeSessions.set(streamSid, session);

        logger.info('[tataStream] Stream started', {
          streamSid,
          callSid,
          conversationId: session.conversationId,
          from: startData.from,
          to: startData.to,
          direction: startData.direction,
          projectName: session.projectName,
        });

        if (session.openerText && session.conversationId) {
          setImmediate(async () => {
            try {
              await streamTtsToTata(session, session.openerText);
              session.openerPlayed = true;
            } catch (e) {
              logger.error('[tataStream] Opener TTS failed', { streamSid, error: e.message });
            }
          });
        }
        break;
      }

      case 'media': {
        if (!session) break;
        const payload = msg.media?.payload;
        if (!payload) break;

        const audioBuf = Buffer.from(payload, 'base64');
        const energy = computeEnergy(audioBuf);

        if (energy > SILENCE_THRESHOLD) {
          if (session.processing) {
            clearTataAudio(session);
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
            session.isSpeaking = false;
            session.silenceFrameCount = 0;
            processUtterance(session);
          }
        }

        if (session.totalBufferedBytes > MAX_BUFFER_SECONDS * 8000) {
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
 * The custom_identifier JSON (set during click_to_call_support) may arrive
 * in customParameters or we decode it from the connection URL query.
 */
function parseSessionMeta(customParams, req) {
  let cid = customParams;
  if (typeof customParams === 'string') {
    try { cid = JSON.parse(customParams); } catch { cid = {}; }
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
  const openerText = cid.opener || '';

  return { conversationId, orgId, userId, locale, projectName, openerText };
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
 */
function handleVoiceStreamResolve(req, res) {
  try {
    const { callId, fromNumber, toNumber } = req.body || {};
    const baseWss = buildWssUrl(req);
    const params = new URLSearchParams();
    if (callId) params.set('callId', callId);
    if (fromNumber) params.set('fromNumber', fromNumber);
    if (toNumber) params.set('toNumber', toNumber);

    const sep = baseWss.includes('?') ? '&' : '?';
    const wss_url = params.toString() ? `${baseWss}${sep}${params.toString()}` : baseWss;

    logger.info('[tataStream] Dynamic endpoint resolved', { callId, wss_url: wss_url.slice(0, 120) });

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
