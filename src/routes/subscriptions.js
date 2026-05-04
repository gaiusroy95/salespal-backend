const {  Router  } = require('express');
const subscriptionsController = require('../controllers/subscriptions.controller.js');
const {  requireAuth  } = require('../middleware/auth.js');
const {  uploadNone  } = require('../middleware/upload.js');

const router = Router();

router.use(requireAuth);

router.get('/', subscriptionsController.listSubscriptions);
router.post('/activate', uploadNone, subscriptionsController.activateSubscription);
router.put('/:module/pause', uploadNone, subscriptionsController.pauseSubscription);
router.put('/:module/resume', uploadNone, subscriptionsController.resumeSubscription);
router.put('/:module/deactivate', uploadNone, subscriptionsController.deactivateSubscription);

module.exports = router;
