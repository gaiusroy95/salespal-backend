const { Router } = require('express');
const multer = require('multer');
const { body, param } = require('express-validator');
const validate = require('../middleware/validate');
const { aiLimiter, voiceTtsLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/ai.controller');

const router = Router();

const voiceSttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

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
router.post('/voice/stt', voiceTtsLimiter, voiceSttUpload.single('audio'), ctrl.voiceSttTranscribe);
router.get('/voice/stack-profiles', aiLimiter, ctrl.listVoiceStackProfilesHandler);
router.get('/voice/stack-profiles/:profileId/artifacts', aiLimiter, ctrl.getVoiceStackProfileArtifacts);
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
router.post(
  '/voice/session/realtime-moderate',
  aiLimiter,
  [body('conversationId').notEmpty().withMessage('conversationId is required'), body('text').notEmpty().withMessage('text is required')],
  validate,
  ctrl.moderateRealtimeVoice
);
router.post(
  '/voice/session/takeover',
  aiLimiter,
  [body('conversationId').notEmpty().withMessage('conversationId is required'), body('mode').optional().isIn(['ai', 'human'])],
  validate,
  ctrl.setVoiceConversationTakeover
);
router.get('/voice/session/history', aiLimiter, ctrl.voiceHistory);
router.get('/voice/session/actions', aiLimiter, ctrl.voiceActions);
router.post('/voice/session/summary', aiLimiter, ctrl.summarizeVoice);
router.get('/voice/owner-summary', aiLimiter, ctrl.ownerVoiceSummary);
router.post('/video/jobs', aiLimiter, ctrl.createVideoJob);
router.get('/video/jobs/:jobId', aiLimiter, ctrl.getVideoJob);
router.get('/video/jobs/:jobId/stream', aiLimiter, ctrl.streamVideoJobMedia);

module.exports = router;
