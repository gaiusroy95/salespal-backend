const {  Router  } = require('express');
const utilsController = require('../controllers/utils.controller.js');
const {  requireAuth  } = require('../middleware/auth.js');

const router = Router();

router.use(requireAuth);

router.get('/fetch-website-data', utilsController.fetchWebsiteData);

module.exports = router;
