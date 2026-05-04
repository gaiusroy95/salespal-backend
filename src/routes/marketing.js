const { Router } = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/marketing.controller');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

// Campaigns
router.get('/campaigns', [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })], validate, ctrl.listCampaigns);
router.get('/campaigns/:id', [param('id').isUUID()], validate, ctrl.getCampaign);
router.post('/campaigns', [body('name').notEmpty().withMessage('Campaign name is required')], validate, ctrl.createCampaign);
router.put('/campaigns/:id', [param('id').isUUID()], validate, ctrl.updateCampaign);
router.delete('/campaigns/:id', [param('id').isUUID()], validate, ctrl.deleteCampaign);

// Campaign Drafts (Wizard)
router.get('/drafts', ctrl.listDrafts);
router.get('/drafts/:id', [param('id').isUUID()], validate, ctrl.getDraft);
router.post('/drafts', ctrl.createDraft);
router.put('/drafts/:id', [param('id').isUUID()], validate, ctrl.updateDraft);
router.post('/drafts/:id/launch', [param('id').isUUID()], validate, ctrl.launchDraft);
router.delete('/drafts/:id', [param('id').isUUID()], validate, ctrl.deleteDraft);

// Platform publish & performance sync
router.post('/campaigns/:id/publish', [param('id').isUUID()], validate, ctrl.publishCampaign);
router.post('/campaigns/:id/sync-performance', [param('id').isUUID()], validate, ctrl.syncPerformance);

// AI Tools
router.post('/ai-analyze', upload.any(), ctrl.analyzeBusiness);
router.post('/generate-ads', ctrl.generateAds);
router.post('/generate-ad-image', ctrl.generateAdImage);

// Social Studio (staging -> approval -> publish)
router.get('/social-studio/posts', ctrl.listSocialStudioPosts);
router.post('/social-studio/posts', ctrl.createSocialStudioPost);
router.post('/social-studio/posts/:id/approve', [param('id').isUUID()], validate, ctrl.approveSocialStudioPost);
router.post('/social-studio/posts/:id/publish', [param('id').isUUID()], validate, ctrl.publishSocialStudioPost);

module.exports = router;
