const {  Router  } = require('express');
const salesCampaignsController = require('../controllers/salesCampaigns.controller.js');
const {  requireAuth  } = require('../middleware/auth.js');
const {  uploadSingle, uploadNone  } = require('../middleware/upload.js');

const router = Router();

router.use(requireAuth);

router.post('/create', uploadSingle, salesCampaignsController.createSalesCampaign);
router.get('/analyze/status', salesCampaignsController.getCampaignAnalyzeStatus);
router.get('/:id/analyze/status', salesCampaignsController.getCampaignAnalyzeStatus);
router.post('/:id/analyze', uploadNone, salesCampaignsController.analyzeCampaignReport);
router.get('/:id/leads', salesCampaignsController.getCampaignLeads);
router.post('/:id/leads', uploadNone, salesCampaignsController.addCampaignLead);
router.post('/:id/website', uploadNone, salesCampaignsController.saveCampaignWebsite);
router.post('/:id/lead-form/facebook', uploadNone, salesCampaignsController.createFacebookLeadForm);
router.post('/:id/sync-leads/facebook', uploadNone, salesCampaignsController.syncLeadsFromFacebook);
router.post('/:id/sync-leads/google',   uploadNone, salesCampaignsController.syncLeadsFromGoogle);

// Global lead uploads (mapped to /sales/leads/upload/...)
router.post('/upload/csv', uploadSingle, salesCampaignsController.uploadCsvLeads);
router.post('/upload/pdf', uploadSingle, salesCampaignsController.uploadPdfLeads);

module.exports = router;
