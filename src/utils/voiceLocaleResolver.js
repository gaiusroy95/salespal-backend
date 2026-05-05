/**
 * Lightweight global dial-code locale hints for first-turn voice handling.
 * Fallback remains "en" when unknown.
 */
const DIAL_CODE_LOCALE_MAP = [
  { code: '971', locale: 'ar-en' }, // UAE
  { code: '966', locale: 'ar' }, // Saudi
  { code: '974', locale: 'ar' }, // Qatar
  { code: '973', locale: 'ar' }, // Bahrain
  { code: '965', locale: 'ar' }, // Kuwait
  { code: '968', locale: 'ar' }, // Oman
  { code: '20', locale: 'ar' }, // Egypt
  { code: '91', locale: 'hing' }, // India default
  { code: '880', locale: 'bn' }, // Bangladesh
  { code: '94', locale: 'si-en' }, // Sri Lanka
  { code: '977', locale: 'ne' }, // Nepal
  { code: '92', locale: 'ur' }, // Pakistan
  { code: '81', locale: 'ja' }, // Japan
  { code: '82', locale: 'ko' }, // Korea
  { code: '86', locale: 'zh' }, // China
  { code: '65', locale: 'en' }, // Singapore
  { code: '60', locale: 'ms-en' }, // Malaysia
  { code: '66', locale: 'th' }, // Thailand
  { code: '84', locale: 'vi' }, // Vietnam
  { code: '62', locale: 'id' }, // Indonesia
  { code: '63', locale: 'tl-en' }, // Philippines
  { code: '44', locale: 'en' }, // UK
  { code: '353', locale: 'en' }, // Ireland
  { code: '33', locale: 'fr' }, // France
  { code: '49', locale: 'de' }, // Germany
  { code: '39', locale: 'it' }, // Italy
  { code: '34', locale: 'es' }, // Spain
  { code: '351', locale: 'pt' }, // Portugal
  { code: '31', locale: 'nl' }, // Netherlands
  { code: '32', locale: 'fr-nl' }, // Belgium
  { code: '41', locale: 'de-fr-it' }, // Switzerland
  { code: '46', locale: 'sv' }, // Sweden
  { code: '47', locale: 'no' }, // Norway
  { code: '45', locale: 'da' }, // Denmark
  { code: '48', locale: 'pl' }, // Poland
  { code: '90', locale: 'tr' }, // Turkey
  { code: '7', locale: 'ru' }, // Russia/Kazakh region
  { code: '1', locale: 'en' }, // US/Canada/NANP
  { code: '52', locale: 'es' }, // Mexico
  { code: '55', locale: 'pt' }, // Brazil
  { code: '54', locale: 'es' }, // Argentina
  { code: '56', locale: 'es' }, // Chile
  { code: '57', locale: 'es' }, // Colombia
  { code: '51', locale: 'es' }, // Peru
  { code: '61', locale: 'en' }, // Australia
  { code: '64', locale: 'en' }, // New Zealand
  { code: '27', locale: 'en' }, // South Africa
  { code: '234', locale: 'en' }, // Nigeria
  { code: '254', locale: 'en-sw' }, // Kenya
  { code: '251', locale: 'am-en' }, // Ethiopia
];

function normalizePhoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function resolveLocaleFromDialCode(phone) {
  const digits = normalizePhoneDigits(phone);
  if (!digits) return null;
  const sorted = [...DIAL_CODE_LOCALE_MAP].sort((a, b) => b.code.length - a.code.length);
  for (const row of sorted) {
    if (digits.startsWith(row.code)) return row.locale;
  }
  return null;
}

module.exports = {
  resolveLocaleFromDialCode,
  normalizePhoneDigits,
};
