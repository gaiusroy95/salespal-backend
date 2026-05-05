const express = require('express');
const ctrl = require('../controllers/webhooks.controller');

const router = express.Router();

router.post('/tata/call-status', ctrl.tataCallStatus);
router.get('/whatsapp/meta', ctrl.whatsappVerifyWebhook);
router.post('/whatsapp/meta', ctrl.whatsappInbound);

module.exports = router;
