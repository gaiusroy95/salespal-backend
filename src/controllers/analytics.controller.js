const db = require('../config/db');
const analyticsService = require('../services/analytics.service');

async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

async function getDashboard(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ revenue: {}, leads: {}, platforms: [], dailyMetrics: [], topCampaigns: [] });

    const period = req.query.period || '30d';

    const [revenue, leads, platforms, dailyMetrics, topCampaigns, comparison] = await Promise.all([
      analyticsService.getRevenueSummary(orgId, period),
      analyticsService.getLeadMetrics(orgId, period),
      analyticsService.getPlatformBreakdown(orgId, period),
      analyticsService.getDailyMetrics(orgId, period),
      analyticsService.getTopCampaigns(orgId, period),
      analyticsService.getPeriodComparison(orgId, period),
    ]);

    res.json({ revenue, leads, platforms, dailyMetrics, topCampaigns, comparison });
  } catch (err) {
    next(err);
  }
}

async function getRevenue(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({});
    const data = await analyticsService.getRevenueSummary(orgId, req.query.period || '30d');
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getLeads(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({});
    const data = await analyticsService.getLeadMetrics(orgId, req.query.period || '30d');
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getPlatforms(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);
    const data = await analyticsService.getPlatformBreakdown(orgId, req.query.period || '30d');
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getDailyMetrics(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);
    const data = await analyticsService.getDailyMetrics(orgId, req.query.period || '30d');
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getComparison(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({});
    const data = await analyticsService.getPeriodComparison(orgId, req.query.period || '30d');
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getLeadsOverTime(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);
    const data = await analyticsService.getLeadsOverTime(orgId, req.query.period || '30d');
    res.json(data);
  } catch (err) {
    next(err);
  }
}

async function getCampaignMetricsRaw(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);
    
    // We fetch raw campaign_metrics and join with campaigns
    // to match Supabase's `select('*, campaigns(name, platform, project_id)')`
    const { rows } = await db.query(`
      SELECT 
        m.*,
        m.metric_date as date,
        json_build_object(
          'name', c.name, 
          'platform', c.platform, 
          'project_id', c.project_id
        ) as campaigns
      FROM campaign_daily_metrics m
      JOIN campaigns c ON m.campaign_id = c.id
      WHERE m.org_id = $1
      ORDER BY m.metric_date ASC
    `, [orgId]);
    
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

module.exports = { getDashboard, getRevenue, getLeads, getPlatforms, getDailyMetrics, getComparison, getLeadsOverTime, getCampaignMetricsRaw };
