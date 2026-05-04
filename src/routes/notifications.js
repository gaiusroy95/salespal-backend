const { Router } = require('express');
const ctrl = require('../controllers/notifications.controller');

const router = Router();

// Static routes BEFORE parameterized routes
router.get('/preferences', ctrl.getPreferences);
router.put('/preferences', ctrl.updatePreferences);
router.put('/read-all', ctrl.markAllRead);

router.get('/', ctrl.listNotifications);
router.put('/:id/read', ctrl.markRead);

module.exports = router;
