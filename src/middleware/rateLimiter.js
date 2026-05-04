const rateLimit = require('express-rate-limit');
const env = require('../config/env');

/**
 * Default rate limiter — applies globally.
 */
const defaultLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.method === 'OPTIONS') return true;
    const p = req.path || '';
    if (p === '/health' || p === '/favicon.ico') return true;
    return false;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please try again later.',
      },
    });
  },
});

/**
 * Auth rate limiter (login, register).
 * Keyed by IP + email so shared NAT / office networks are not blocked as one user.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    return email ? `${req.ip}:${email}` : req.ip;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many authentication attempts. Please wait 15 minutes.',
      },
    });
  },
});

/**
 * AI endpoint rate limiter.
 * 20 requests per 1-minute window.
 */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    if (req.method === 'OPTIONS') return true;
    const p = String(req.path || '');
    // Video job polling endpoints are frequently called by design while generation is in-progress.
    // Keep them out of the strict AI limiter to avoid false-positive 429s under multi-user load.
    if (req.method === 'GET' && /^\/video\/jobs\/[^/]+(?:\/stream)?$/i.test(p)) return true;
    return false;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'AI request limit reached. Please wait a moment.',
      },
    });
  },
});

/**
 * TTS can be polled once per utterance; allow higher throughput than generic AI routes.
 */
const voiceTtsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  handler: (req, res) => {
    res.status(429).json({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'TTS request limit reached. Please wait a moment.',
      },
    });
  },
});

module.exports = { defaultLimiter, authLimiter, aiLimiter, voiceTtsLimiter };
