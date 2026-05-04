const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/billing.controller');

const router = Router();

router.get('/plans', ctrl.getPlans);
router.get('/subscriptions', ctrl.getSubscriptions);
router.post('/subscriptions/activate', [body('moduleId').notEmpty().withMessage('moduleId is required')], validate, ctrl.activateSubscription);
router.post('/subscriptions/:moduleId/deactivate', [param('moduleId').notEmpty()], validate, ctrl.deactivateSubscription);
router.post('/subscriptions/:moduleId/pause', [param('moduleId').notEmpty()], validate, ctrl.pauseSubscription);
router.post('/subscriptions/:moduleId/resume', [param('moduleId').notEmpty()], validate, ctrl.resumeSubscription);

router.get('/credits', ctrl.getCredits);
router.post('/credits/consume', [body('type').notEmpty().withMessage('Credit type is required')], validate, ctrl.consumeCredit);
router.post('/credits/add', [body('amount').isInt({ min: 1 }).withMessage('Amount must be a positive integer')], validate, ctrl.addCredits);
router.get('/credits/transactions', ctrl.getCreditTransactions);

module.exports = router;
