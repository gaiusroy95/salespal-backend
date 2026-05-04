/**
 * Indian etiquette: polite “Ji” suffix on the customer name (DB spelling preserved).
 */

function honorificNameJi(fullName) {
  const raw = String(fullName || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/,+$/g, '')
    .trim();
  if (!raw) return '';
  if (/\bjis?\s*$/i.test(raw.replace(/\.$/, '').trim())) return raw;
  return `${raw} Ji`;
}

module.exports = { honorificNameJi };
