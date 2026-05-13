const { Router } = require('express');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/sales.controller');

const router = Router();

router.get('/', [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })], validate, ctrl.listDeals);
router.get('/activities', [query('limit').optional().isInt({ min: 1, max: 100 }), query('offset').optional().isInt({ min: 0 })], validate, ctrl.listActivities);

// Sales Campaigns (CRM layer)
router.post('/campaigns/create', [body('name').notEmpty().withMessage('Campaign name is required')], validate, ctrl.createSalesCampaign);
router.post('/campaigns/:campaignId/website', [
  param('campaignId').isUUID(),
  body('websiteUrl').notEmpty().withMessage('websiteUrl is required'),
], validate, ctrl.saveCampaignWebsite);
router.post('/campaigns/:campaignId/communication-setup', [
  param('campaignId').isUUID(),
], validate, ctrl.saveCampaignCommunicationSetup);
router.post(
  '/campaigns/:campaignId/enqueue-call-queue',
  [
    param('campaignId').isUUID(),
    body('gapSeconds').optional().isInt({ min: 45, max: 900 }),
    body('replacePending').optional().isBoolean(),
  ],
  validate,
  ctrl.enqueueCampaignCallQueue
);
router.get('/campaign-goal-samples', ctrl.listCampaignGoalSamples);
router.get('/campaigns/:campaignId/leads', [param('campaignId').isUUID()], validate, ctrl.listCampaignLeads);
router.post('/campaigns/:campaignId/leads', [
  param('campaignId').isUUID(),
  body('name').notEmpty().withMessage('Lead name is required'),
  body('phone').notEmpty().withMessage('Phone is required'),
], validate, ctrl.addCampaignLead);

router.get(
  '/:id/actions',
  [param('id').isUUID(), query('limit').optional().isInt({ min: 1, max: 500 })],
  validate,
  ctrl.listLeadActions
);
router.post(
  '/:id/actions',
  [
    param('id').isUUID(),
    body('type').isIn(['call', 'whatsapp', 'email', 'note', 'meeting', 'ai_action']),
    body('content').optional().isString().isLength({ max: 100000 }),
    body('outcome').optional({ nullable: true }).isString(),
    body('durationSeconds').optional({ nullable: true }).isInt({ min: 0, max: 864000 }),
    body('metadata').optional().isObject(),
  ],
  validate,
  ctrl.createLeadAction
);
router.post(
  '/:id/automation-jobs',
  [
    param('id').isUUID(),
    body('sourceChannel').isIn(['call', 'whatsapp', 'ai_chat']),
    body('targetChannel').isIn(['call', 'whatsapp']),
    body('scheduleAt').isISO8601().withMessage('scheduleAt must be an ISO date string'),
    body('payload').optional().isObject(),
  ],
  validate,
  ctrl.createAutomationJob
);
router.post(
  '/automation-jobs/dispatch-due',
  [body('limit').optional().isInt({ min: 1, max: 100 })],
  validate,
  ctrl.dispatchDueAutomationJobs
);
router.post(
  '/automation-jobs/owner-reports/dispatch',
  [
    body('mode').optional().isIn(['morning', 'evening']),
    body('timezone').optional().isString().isLength({ max: 64 }),
  ],
  validate,
  ctrl.dispatchOwnerDailyReports
);
router.get('/automation-jobs/owner-reports/settings', ctrl.getOwnerReportSettingsHandler);
router.put(
  '/automation-jobs/owner-reports/settings',
  [
    body('morningEnabled').optional().isBoolean(),
    body('eveningEnabled').optional().isBoolean(),
    body('timezone').optional().isString().isLength({ max: 64 }),
  ],
  validate,
  ctrl.updateOwnerReportSettingsHandler
);
router.get(
  '/:id/automation-jobs',
  [param('id').isUUID(), query('status').optional().isIn(['pending', 'dispatched', 'cancelled', 'completed'])],
  validate,
  ctrl.listLeadAutomationJobs
);
router.patch(
  '/automation-jobs/:jobId/status',
  [
    param('jobId').isUUID(),
    body('status').isIn(['cancelled', 'completed']),
  ],
  validate,
  ctrl.updateAutomationJobStatus
);
router.post(
  '/:id/automation-jobs/cleanup',
  [
    param('id').isUUID(),
    body('targetChannel').optional().isIn(['call', 'whatsapp']),
  ],
  validate,
  ctrl.cleanupLeadAutomationJobs
);
router.post(
  '/:id/whatsapp/takeover',
  [
    param('id').isUUID(),
    body('mode').optional().isIn(['ai', 'human']),
    body('expiresInMins').optional().isInt({ min: 1, max: 120 }),
  ],
  validate,
  ctrl.setWhatsAppTakeover
);

router.get('/:id', [param('id').isUUID()], validate, ctrl.getDeal);
router.post(
  '/',
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('contact_phone')
      .optional()
      .isString()
      .isLength({ min: 7, max: 20 })
      .withMessage('contact_phone must be between 7 and 20 characters'),
    body('contact_email')
      .optional({ nullable: true, checkFalsy: true })
      .isEmail()
      .withMessage('contact_email must be a valid email'),
  ],
  validate,
  ctrl.createDeal
);
router.put('/:id', [param('id').isUUID()], validate, ctrl.updateDeal);
router.delete('/:id', [param('id').isUUID()], validate, ctrl.deleteDeal);

module.exports = router;
