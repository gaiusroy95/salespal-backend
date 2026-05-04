const { Router } = require('express');
const { body } = require('express-validator');
const integrationsController = require('../controllers/integrations.controller.js');
const { requireAuth } = require('../middleware/auth.js');
const { uploadNone } = require('../middleware/upload.js');
const validate = require('../middleware/validate');

const router = Router();

router.use(requireAuth);

// Existing integration CRUD routes
router.get('/', integrationsController.listIntegrations);
router.put('/:platform', uploadNone, integrationsController.upsertIntegration);
router.delete('/:platform', integrationsController.disconnectIntegration);

// Facebook / Meta OAuth routes
router.get('/meta/auth-url', integrationsController.getFacebookAuthUrl);
router.post('/meta/callback', integrationsController.handleFacebookCallback);
router.post('/meta/refresh', integrationsController.refreshFacebookToken);
router.get('/instagram/auth-url', integrationsController.getInstagramAuthUrl);
router.post('/instagram/callback', integrationsController.handleInstagramCallback);

// Google OAuth routes
router.get('/google/auth-url', integrationsController.getGoogleAuthUrl);
router.post('/google/callback', integrationsController.handleGoogleCallback);
router.patch('/google/customer-id', uploadNone, integrationsController.updateGoogleCustomerId);
router.post('/google/sync', integrationsController.syncGoogleCampaigns);

// LinkedIn OAuth routes
router.get('/linkedin/auth-url', integrationsController.getLinkedInAuthUrl);
router.post('/linkedin/callback', integrationsController.handleLinkedInCallback);

// Health check
router.get('/health', integrationsController.checkIntegrationHealth);
router.get('/readiness', integrationsController.checkSalesPalReadiness);
router.get('/deployed-numbers', integrationsController.listDeployedNumbers);

router.post(
  '/whatsapp/send-template',
  uploadNone,
  [
    body('leadId').optional().isUUID(),
    body('lead_id').optional().isUUID(),
    body('to').optional().isString(),
    body('template_name').optional().isString(),
    body('templateName').optional().isString(),
    body('asset_id').optional().isUUID(),
    body('assetId').optional().isUUID(),
  ],
  validate,
  integrationsController.postWhatsAppSendTemplate
);

module.exports = router;
