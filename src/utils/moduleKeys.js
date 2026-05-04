const CANONICAL_MODULES = ['marketing', 'sales', 'post-sales', 'support', 'salespal-360'];

function normalizeModuleKey(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'postsale' || v === 'post_sale' || v === 'postsales' || v === 'post-sale') return 'post-sales';
  if (v === 'salespal360' || v === 'bundle' || v === 'salespal_360') return 'salespal-360';
  if (v === 'salespal-360') return 'salespal-360';
  if (v === 'post-sales') return 'post-sales';
  return v;
}

function expandBundle(moduleKey) {
  const k = normalizeModuleKey(moduleKey);
  if (k === 'salespal-360') return [...CANONICAL_MODULES];
  return [k];
}

module.exports = {
  CANONICAL_MODULES,
  normalizeModuleKey,
  expandBundle,
};
