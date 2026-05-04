const { Router } = require('express');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { aiLimiter, voiceTtsLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/ai.controller');

const router = Router();

router.post(
  '/chat',
  aiLimiter,
  [
    body('message').notEmpty().withMessage('Message is required'),
    body('context').optional().isIn(['whatsapp']),
    body('history').optional().isArray(),
  ],
  validate,
  ctrl.chat
);
router.get('/campaigns/:campaignId/analyze', aiLimiter, [param('campaignId').isUUID()], validate, ctrl.analyzeCampaign);
router.get('/insights', aiLimiter, ctrl.getStrategicInsights);
router.post('/ad-copy', aiLimiter, [body('productName').notEmpty().withMessage('Product name is required')], validate, ctrl.generateAdCopy);
router.post('/compliance/scan-calling-script', aiLimiter, ctrl.scanCallingScriptCompliance);
router.post(
  '/voice/tts',
  voiceTtsLimiter,
  [body('text').notEmpty().withMessage('text is required'), body('locale').optional().isString().isLength({ max: 32 })],
  validate,
  ctrl.voiceTts
);
router.post(
  '/voice/session/start',
  aiLimiter,
  [
    body('openerContext').optional().isString().isLength({ max: 2000 }),
    body('projectId').optional().isUUID(),
    body('agentName').optional().isString().isLength({ max: 40 }),
  ],
  validate,
  ctrl.startVoiceSession
);
router.post('/voice/session/turn', aiLimiter, [body('text').notEmpty().withMessage('text is required')], validate, ctrl.voiceTurn);
router.get('/voice/session/history', aiLimiter, ctrl.voiceHistory);
router.post('/voice/session/summary', aiLimiter, ctrl.summarizeVoice);
router.get('/voice/owner-summary', aiLimiter, ctrl.ownerVoiceSummary);
router.post('/video/jobs', aiLimiter, ctrl.createVideoJob);
router.get('/video/jobs/:jobId', aiLimiter, ctrl.getVideoJob);
router.get('/video/jobs/:jobId/stream', aiLimiter, ctrl.streamVideoJobMedia);

module.exports = router;
