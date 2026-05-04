const aiService = require('./ai.service');
const env = require('../config/env');

/**
 * Layer A — pre-dial / campaign script gate. Returns whether the script may proceed.
 */
async function scanCallingScript(scriptText) {
  const body = String(scriptText || '').trim();
  if (!body) {
    return { allowed: true, severity: 'clear', reasons: [], blocked: false };
  }
  if (!env.callScriptCompliance) {
    return { allowed: true, severity: 'clear', reasons: [], blocked: false, skipped: true };
  }

  const prompt = `You are a strict telecom + consumer-protection compliance officer for India and global markets.
Review the following OUTBOUND CALLING SCRIPT that a sales org wants to run on live calls (Tata Smartflo / voice bot).

Return STRICT JSON only (no markdown) with keys:
- "blocked" (boolean) — true if the script should NOT be allowed to dial.
- "severity" (one of: clear, warn, block)
- "reasons" (array of short strings)

BLOCK (blocked=true) if the script contains or encourages:
- harassment, threats, intimidation, hate, sexual content, extortion
- illegal financial promises (guaranteed returns, hidden fees obscured, outright fraud)
- impersonation of government/regulators/banks
- abusive collection tactics

WARN (blocked=false, severity=warn) for aggressive but possibly legal pressure — still list reasons.

If acceptable: blocked=false, severity=clear, reasons=[].`;

  try {
    const raw = await aiService.callAIWithMessages(
      [{ role: 'user', content: `Script:\n${body.slice(0, 12000)}` }],
      prompt,
      { temperature: 0.1 }
    );
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    const slice = jsonStart >= 0 ? raw.slice(jsonStart, jsonEnd + 1) : raw;
    const parsed = JSON.parse(slice);
    const blocked = Boolean(parsed.blocked);
    const severity = String(parsed.severity || (blocked ? 'block' : 'clear')).toLowerCase();
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map((r) => String(r).trim()).filter(Boolean) : [];
    return {
      allowed: !blocked,
      blocked,
      severity: blocked ? 'block' : severity,
      reasons,
    };
  } catch (_) {
    return {
      allowed: false,
      blocked: true,
      severity: 'block',
      reasons: ['Automatic compliance scan could not finish — block dial until verified manually.'],
    };
  }
}

module.exports = { scanCallingScript };
