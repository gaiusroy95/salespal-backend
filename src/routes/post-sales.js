const { Router } = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/post-sales.controller');
const { uploadSingle } = require('../middleware/upload');

const router = Router();

// ─── Customers ───────────────────────────────────────────────────────────────
router.get('/customers', ctrl.listCustomers);
router.post('/customers/upload', uploadSingle, ctrl.uploadAndAnalyzeCustomers);
router.get('/customers/:id', [param('id').isUUID()], validate, ctrl.getCustomer);
router.post('/customers', [body('name').notEmpty().withMessage('Name is required')], validate, ctrl.createCustomer);
router.put('/customers/:id', [param('id').isUUID()], validate, ctrl.updateCustomer);
router.delete('/customers/:id', [param('id').isUUID()], validate, ctrl.deleteCustomer);
router.post('/customers/:id/message-suggestion', [param('id').isUUID()], validate, ctrl.suggestCustomerMessage);
router.post('/payments/claim-done', ctrl.claimPaymentDone);
router.post('/payments/verify-claim', ctrl.verifyPaymentClaim);

// ─── AI Customer Analysis ────────────────────────────────────────────────────
router.post('/analyze/text', [body('text').notEmpty().withMessage('Text is required')], validate, ctrl.analyzeCustomerText);
router.post('/analyze/file', uploadSingle, ctrl.analyzeCustomerFile);

// ─── Payments ────────────────────────────────────────────────────────────────
router.get('/payments', ctrl.listPayments);
router.post('/payments', [body('customerId').isUUID(), body('amount').isNumeric()], validate, ctrl.createPayment);
router.patch('/payments/:id/status', [param('id').isUUID(), body('status').notEmpty()], validate, ctrl.updatePaymentStatus);

// ─── Automations ─────────────────────────────────────────────────────────────
router.get('/automations', ctrl.listAutomations);
router.post('/automations', [body('name').notEmpty(), body('trigger').notEmpty(), body('action').notEmpty()], validate, ctrl.createAutomation);
router.patch('/automations/:id/toggle', [param('id').isUUID()], validate, ctrl.toggleAutomation);
router.delete('/automations/:id', [param('id').isUUID()], validate, ctrl.deleteAutomation);

// ─── Follow-ups ──────────────────────────────────────────────────────────────
router.get('/followups', ctrl.listFollowUps);
router.post('/followups', [body('customerId').isUUID(), body('task').notEmpty()], validate, ctrl.createFollowUp);
router.patch('/followups/:id/status', [param('id').isUUID(), body('status').notEmpty()], validate, ctrl.updateFollowUpStatus);

// ─── Documents ───────────────────────────────────────────────────────────────
router.get('/documents', ctrl.listDocuments);
router.post('/documents', [body('customerId').isUUID(), body('name').notEmpty()], validate, ctrl.createDocument);
router.patch('/documents/:id/status', [param('id').isUUID(), body('status').notEmpty()], validate, ctrl.updateDocumentStatus);

// ─── Onboarding ──────────────────────────────────────────────────────────────
router.get('/onboarding', ctrl.listOnboarding);
router.post('/onboarding', [body('customerId').isUUID(), body('stepName').notEmpty()], validate, ctrl.upsertOnboardingStep);

module.exports = router;
