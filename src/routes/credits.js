const {  Router  } = require('express');
const creditsController = require('../controllers/credits.controller.js');
const {  requireAuth  } = require('../middleware/auth.js');

const router = Router();

router.use(requireAuth);

router.get('/', creditsController.getBalance);
router.post('/consume', creditsController.consumeCredits);
router.post('/add', creditsController.addCredits);
router.post('/usage/record', creditsController.recordUsage);
router.get('/transactions', creditsController.getTransactions);
router.get('/usage/summary', creditsController.getUsageSummary);

module.exports = router;
