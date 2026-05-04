const { Router } = require('express');
const { param, body } = require('express-validator');
const validate = require('../middleware/validate');
const { requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/users.controller');

const router = Router();

router.get('/me', ctrl.getMe);
router.put('/me', ctrl.updateMe);
router.get('/me/settings', ctrl.getSettings);
router.put('/me/settings', ctrl.updateSettings);
router.get('/me/org', ctrl.getMyOrg);
router.post('/me/org', [body('name').optional().isString().trim()], validate, ctrl.bootstrapOrg);
router.get('/:id', [param('id').isUUID().withMessage('Valid user ID required')], validate, requireRole('admin', 'user'), ctrl.getUserById);

module.exports = router;
