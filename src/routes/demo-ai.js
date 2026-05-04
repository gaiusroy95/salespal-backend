const { Router } = require('express');
const { body } = require('express-validator');
const validate = require('../middleware/validate');
const { aiLimiter } = require('../middleware/rateLimiter');
const ctrl = require('../controllers/ai.controller');

const router = Router();

// Public demo endpoints (no auth middleware in app.js mount).
router.post('/voice/start', aiLimiter, ctrl.startVoiceSession);
router.post('/voice/turn', aiLimiter, [body('text').notEmpty().withMessage('text is required')], validate, ctrl.voiceTurn);
router.get('/voice/history', aiLimiter, ctrl.voiceHistory);
router.post('/voice/summary', aiLimiter, ctrl.summarizeVoice);

module.exports = router;
