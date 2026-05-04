const { Router } = require('express');
const { query } = require('express-validator');
const validate = require('../middleware/validate');
const ctrl = require('../controllers/analytics.controller');

const router = Router();

const periodValidator = [query('period').optional().isIn(['7d', '30d', '90d', '1y']).withMessage('Period must be 7d, 30d, 90d, or 1y')];

router.get('/dashboard', periodValidator, validate, ctrl.getDashboard);
router.get('/revenue', periodValidator, validate, ctrl.getRevenue);
router.get('/leads', periodValidator, validate, ctrl.getLeads);
router.get('/leads/timeline', periodValidator, validate, ctrl.getLeadsOverTime);
router.get('/platforms', periodValidator, validate, ctrl.getPlatforms);
router.get('/daily', periodValidator, validate, ctrl.getDailyMetrics);
router.get('/comparison', periodValidator, validate, ctrl.getComparison);
router.get('/campaign-metrics', validate, ctrl.getCampaignMetricsRaw);

module.exports = router;
