const express = require('express');
const ctrl = require('../controllers/webhooks.controller');
const tataStreamService = require('../services/tataStream.service');

const router = express.Router();

router.post('/tata/call-status', ctrl.tataCallStatus);
router.post('/tata/voice-stream-resolve', tataStreamService.handleVoiceStreamResolve);
router.get('/tata/voice-stream-resolve', tataStreamService.handleVoiceStreamResolve);
router.get('/whatsapp/meta', ctrl.whatsappVerifyWebhook);
router.post('/whatsapp/meta', ctrl.whatsappInbound);

module.exports = router;
