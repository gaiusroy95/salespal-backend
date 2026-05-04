/**
 * Parse “tomorrow at 10 AM” style phrases into UTC ISO timestamps using fixed-offset
 * calendar zones (no DST drift for India/UAE/KSA hubs).
 */

const ZONE_OFFSET = new Map([
  ['asia/kolkata', '+05:30'],
  ['ist', '+05:30'],
  ['india', '+05:30'],
  ['asia/dubai', '+04:00'],
  ['dubai', '+04:00'],
  ['asia/riyadh', '+03:00'],
  ['asia/singapore', '+08:00'],
]);

function tzHintToOffsetAndKey(rawHint, phoneE164) {
  const p = String(phoneE164 || '').replace(/\D/g, '');
  if (p.startsWith('971')) return { ianaKey: 'asia/dubai', off: '+04:00' };
  if (p.startsWith('966')) return { ianaKey: 'asia/riyadh', off: '+03:00' };
  const h = String(rawHint || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '/');
  if (!h && process.env.LEAD_SCHEDULE_DEFAULT_TZ) {
    const hz = process.env.LEAD_SCHEDULE_DEFAULT_TZ.trim().toLowerCase().replace(/_/g, '/');
    const off = ZONE_OFFSET.get(hz);
    if (off) return { ianaKey: hz, off };
  }
  if (ZONE_OFFSET.has(h)) return { ianaKey: h, off: ZONE_OFFSET.get(h) };
  const offGuess = ZONE_OFFSET.get('asia/kolkata');
  return { ianaKey: 'asia/kolkata', off: offGuess };
}

function tzHintToIANA(rawHint, phoneE164) {
  const { ianaKey } = tzHintToOffsetAndKey(rawHint, phoneE164);
  return ianaKey === 'asia/kolkata'
    ? 'Asia/Kolkata'
    : ianaKey === 'asia/dubai'
      ? 'Asia/Dubai'
      : ianaKey === 'asia/riyadh'
        ? 'Asia/Riyadh'
        : ianaKey === 'asia/singapore'
          ? 'Asia/Singapore'
          : 'Asia/Kolkata';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Calendar Y-M-D in IANA tz (Intl). */
function calendarYmdInZone(now, zoneIana) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zoneIana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const map = {};
  for (const part of fmt.formatToParts(now)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return { y: Number(map.year), m: Number(map.month), d: Number(map.day) };
}

function addWallDays(y, mo, da, deltaDays) {
  const utcMid = Date.UTC(y, mo - 1, da + deltaDays, 12, 0, 0);
  const dt = new Date(utcMid);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function wallPartsToUtcIso(y, mo, da, hh, mi, offsetStr) {
  const isoLocal = `${y}-${pad2(mo)}-${pad2(da)}T${pad2(hh)}:${pad2(mi)}:00${offsetStr}`;
  const d = new Date(isoLocal);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function resolveHourMinute12(hStr, miStr, ampmRaw) {
  let hh = Number(hStr || 0);
  const mi = Number(miStr || 0);
  const ap = String(ampmRaw || '').toLowerCase();
  if (!Number.isFinite(hh)) return null;
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh < 0 || hh > 23 || mi < 0 || mi > 59) return null;
  return { hh, mi };
}

function parseNaturalScheduleUtcIso(text, { leadTimezoneHint, leadPhone } = {}) {
  const t = String(text || '').trim();
  if (!t) return null;
  const { off } = tzHintToOffsetAndKey(leadTimezoneHint, leadPhone);
  const zoneIana = tzHintToIANA(leadTimezoneHint, leadPhone);
  const now = new Date();
  const low = t.toLowerCase();

  const inHours = low.match(/\b(?:in|after)\s+(\d{1,2})\s*(hour|hours|hr|hrs)\b/);
  if (inHours) {
    const n = Number(inHours[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 3600000).toISOString();
  }
  const inMins = low.match(/\b(?:in|after)\s+(\d{1,3})\s*(minute|minutes|min|mins)\b/);
  if (inMins) {
    const n = Number(inMins[1] || 1);
    if (Number.isFinite(n) && n > 0) return new Date(now.getTime() + n * 60000).toISOString();
  }

  const dayExplicit = /\bday\s+after\s+tomorrow\b/i.test(low)
    ? 2
    : /\btomorrow\b/i.test(low)
      ? 1
      : /\btoday\b/i.test(low)
        ? 0
        : null;

  let hh;
  let mm = 0;
  const tmAmpm = t.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (tmAmpm) {
    const hm = resolveHourMinute12(tmAmpm[1], tmAmpm[2] || '0', tmAmpm[3]);
    if (!hm) return null;
    hh = hm.hh;
    mm = hm.mi;
  } else {
    const tm24 = t.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\b/);
    if (!tm24) return null;
    hh = Number(tm24[1] || 0);
    mm = Number(tm24[2] || 0);
    if (!Number.isFinite(hh) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  }

  const { y, m, d } = calendarYmdInZone(now, zoneIana);
  let wd = dayExplicit !== null ? dayExplicit : 0;
  let target = addWallDays(y, m, d, wd);
  let isoOut = wallPartsToUtcIso(target.y, target.m, target.d, hh, mm, off);
  if (!isoOut) return null;

  if (isoOut <= new Date(now.getTime() - 60 * 1000).toISOString()) {
    if (dayExplicit === null || dayExplicit === 0) {
      target = addWallDays(y, m, d, wd + 1);
      isoOut = wallPartsToUtcIso(target.y, target.m, target.d, hh, mm, off);
    }
  }
  return isoOut;
}

module.exports = {
  parseNaturalScheduleUtcIso,
  tzHintToIANA,
};
