/**
 * Platform administrators (users.role = 'admin') skip paid usage metering
 * and heavy cloud AI where noted in controllers.
 */
function isPlatformAdmin(user) {
  return String(user?.role || '').toLowerCase() === 'admin';
}

module.exports = { isPlatformAdmin };
