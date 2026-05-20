/** Default public pricing when DB/platform_settings is unavailable. */
const DEFAULT_PUBLIC_PRICING = [
  { productType: 'marketing', name: 'Marketing', monthlyPrice: 5999, yearlyPrice: 59990 },
  { productType: 'sales', name: 'Sales', monthlyPrice: 9999, yearlyPrice: 99990 },
  { productType: 'post-sales', name: 'Post-Sales', monthlyPrice: 9999, yearlyPrice: 99990 },
  { productType: 'support', name: 'Support', monthlyPrice: 9999, yearlyPrice: 99990 },
  { productType: 'salespal-360', name: 'SalesPal 360', monthlyPrice: 29999, yearlyPrice: 299990 },
];

const DEFAULT_MODULE_ACCESS = {
  marketing: true,
  sales: true,
  'post-sales': true,
  support: true,
};

const DEFAULT_MAINTENANCE = {
  global: { enabled: false, reason: '', eta: '', scheduled_start: null, scheduled_end: null, notify_users: false },
  modules: {
    marketing: { enabled: false, reason: '', eta: '' },
    sales: { enabled: false, reason: '', eta: '' },
    'post-sales': { enabled: false, reason: '', eta: '' },
    support: { enabled: false, reason: '', eta: '' },
  },
};

function parseSettingsValue(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Strip cloud-AI quota text from auth errors shown to end users. */
function sanitizeAuthErrorMessage(message) {
  const msg = String(message || '').trim();
  if (!msg) return 'Sign-in failed. Please check your email and password.';
  if (/quota|compute time|resource_exhausted|vertex|gemini|generativelanguage|upgrade your plan/i.test(msg)) {
    return 'Sign-in is temporarily unavailable. Please try again in a moment or use Google sign-in.';
  }
  return msg;
}

module.exports = {
  DEFAULT_PUBLIC_PRICING,
  DEFAULT_MODULE_ACCESS,
  DEFAULT_MAINTENANCE,
  parseSettingsValue,
  sanitizeAuthErrorMessage,
};
