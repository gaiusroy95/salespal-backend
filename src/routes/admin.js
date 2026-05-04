const { Router } = require('express');
const adminController = require('../controllers/admin.controller.js');
const { requireAuth, requireAdmin } = require('../middleware/auth.js');

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

// ─── Existing routes ──────────────────────────────────────────────────────────
router.get('/users', adminController.listUsers);
router.get('/subscriptions', adminController.listSubscriptions);
router.get('/projects', adminController.listProjects);
router.get('/campaigns', adminController.listCampaigns);
router.get('/analytics', adminController.getAnalytics);
router.get('/settings', adminController.getSettings);
router.put('/settings', adminController.updateSettings);

// ─── Platform Config ──────────────────────────────────────────────────────────
router.get('/settings/platform', adminController.getPlatformConfig);
router.put('/settings/platform', adminController.updatePlatformConfig);

// ─── Module Pricing ───────────────────────────────────────────────────────────
router.get('/module-pricing', adminController.getModulePricing);
router.put('/module-pricing/:module', adminController.updateModulePricing);

// ─── User Roles & Status ─────────────────────────────────────────────────────
router.patch('/users/:id/role', adminController.updateUserRole);
router.patch('/users/:id/status', adminController.updateUserStatus);

// ─── Billing Control ─────────────────────────────────────────────────────────
router.patch('/subscriptions/:id', adminController.updateSubscription);
router.post('/refund', adminController.issueRefund);

// ─── Notification Settings ───────────────────────────────────────────────────
router.get('/settings/notifications', adminController.getNotificationSettings);
router.put('/settings/notifications', adminController.updateNotificationSettings);
router.get('/settings/compliance', adminController.getComplianceSettings);
router.put('/settings/compliance', adminController.updateComplianceSettings);
router.post('/notifications/broadcast', adminController.broadcastNotification);

// ─── Admin Notification Feed ─────────────────────────────────────────────────
router.get('/notifications', adminController.listAdminNotifications);
router.put('/notifications/read-all', adminController.markAllAdminNotificationsRead);
router.put('/notifications/:id/read', adminController.markAdminNotificationRead);

// ─── Security & Audit Logs ───────────────────────────────────────────────────
router.get('/audit-logs', adminController.getAuditLogs);
router.post('/force-logout/:userId', adminController.forceLogout);

module.exports = router;
