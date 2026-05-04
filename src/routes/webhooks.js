const express = require('express');
const ctrl = require('../controllers/webhooks.controller');

const router = express.Router();

router.post('/tata/call-status', ctrl.tataCallStatus);

module.exports = router;
