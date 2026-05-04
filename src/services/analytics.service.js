const db = require('../config/db');

/**
 * Parse a period string (7d, 30d, 90d, 1y) into a PostgreSQL interval
 * and compute the start date.
 */
function parsePeriod(period) {
  const map = {
    '7d': { interval: '7 days', days: 7 },
    '30d': { interval: '30 days', days: 30 },
    '90d': { interval: '90 days', days: 90 },
    '1y': { interval: '365 days', days: 365 },
  };
  return map[period] || map['30d'];
}

/**
 * Get revenue and spend summary for an org within a time period.
 */
async function getRevenueSummary(orgId, period = '30d') {
  const { interval } = parsePeriod(period);

  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(spend), 0) AS total_spend,
       COALESCE(SUM(revenue), 0) AS total_revenue,
       CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) ELSE 0 END AS roas,
       COUNT(*)::INTEGER AS campaign_count
     FROM campaigns
     WHERE org_id = $1
       AND created_at >= NOW() - $2::INTERVAL
       AND status != 'draft'`,
    [orgId, interval]
  );

  return rows[0];
}

/**
 * Get lead count and conversion metrics for an org within a time period.
 */
async function getLeadMetrics(orgId, period = '30d') {
  const { interval } = parsePeriod(period);

  const { rows } = await db.query(
    `SELECT
       COUNT(*)::INTEGER AS total_leads,
       COUNT(*) FILTER (WHERE status = 'converted')::INTEGER AS converted_leads,
       CASE
         WHEN COUNT(*) > 0
         THEN (COUNT(*) FILTER (WHERE status = 'converted')::NUMERIC / COUNT(*)::NUMERIC) * 100
         ELSE 0
       END AS conversion_rate,
       COALESCE(SUM(value), 0) AS total_value
     FROM leads
     WHERE org_id = $1
       AND created_at >= NOW() - $2::INTERVAL`,
    [orgId, interval]
  );

  return rows[0];
}

/**
 * Get campaign performance breakdown by platform.
 */
async function getPlatformBreakdown(orgId, period = '30d') {
  const { interval } = parsePeriod(period);

  const { rows } = await db.query(
    `SELECT
       platform,
       COUNT(*)::INTEGER AS campaigns,
       COALESCE(SUM(impressions), 0)::INTEGER AS impressions,
       COALESCE(SUM(clicks), 0)::INTEGER AS clicks,
       COALESCE(SUM(conversions), 0)::INTEGER AS conversions,
       COALESCE(SUM(spend), 0) AS spend,
       COALESCE(SUM(revenue), 0) AS revenue,
       CASE WHEN SUM(impressions) > 0
         THEN (SUM(clicks)::NUMERIC / SUM(impressions)::NUMERIC) * 100
         ELSE 0
       END AS ctr,
       CASE WHEN SUM(clicks) > 0
         THEN SUM(spend) / SUM(clicks)
         ELSE 0
       END AS cpc,
       CASE WHEN SUM(spend) > 0
         THEN SUM(revenue) / SUM(spend)
         ELSE 0
       END AS roas
     FROM campaigns
     WHERE org_id = $1
       AND created_at >= NOW() - $2::INTERVAL
       AND status != 'draft'
     GROUP BY platform
     ORDER BY spend DESC`,
    [orgId, interval]
  );

  return rows;
}

/**
 * Get daily metrics time series for charting.
 */
async function getDailyMetrics(orgId, period = '30d') {
  const { interval } = parsePeriod(period);

  const { rows } = await db.query(
    `SELECT
       metric_date,
       SUM(impressions)::INTEGER AS impressions,
       SUM(clicks)::INTEGER AS clicks,
       SUM(conversions)::INTEGER AS conversions,
       SUM(spend) AS spend,
       SUM(revenue) AS revenue
     FROM campaign_daily_metrics
     WHERE org_id = $1
       AND metric_date >= CURRENT_DATE - $2::INTERVAL
     GROUP BY metric_date
     ORDER BY metric_date ASC`,
    [orgId, interval]
  );

  return rows;
}

/**
 * Get period-over-period comparison (current vs previous).
 */
async function getPeriodComparison(orgId, period = '30d') {
  const { days } = parsePeriod(period);

  const { rows } = await db.query(
    `WITH current_period AS (
       SELECT
         COALESCE(SUM(spend), 0) AS spend,
         COALESCE(SUM(revenue), 0) AS revenue,
         COALESCE(SUM(clicks), 0)::INTEGER AS clicks,
         COALESCE(SUM(impressions), 0)::INTEGER AS impressions,
         COALESCE(SUM(conversions), 0)::INTEGER AS conversions
       FROM campaigns
       WHERE org_id = $1
         AND created_at >= NOW() - ($2 || ' days')::INTERVAL
         AND status != 'draft'
     ),
     previous_period AS (
       SELECT
         COALESCE(SUM(spend), 0) AS spend,
         COALESCE(SUM(revenue), 0) AS revenue,
         COALESCE(SUM(clicks), 0)::INTEGER AS clicks,
         COALESCE(SUM(impressions), 0)::INTEGER AS impressions,
         COALESCE(SUM(conversions), 0)::INTEGER AS conversions
       FROM campaigns
       WHERE org_id = $1
         AND created_at >= NOW() - ($2 * 2 || ' days')::INTERVAL
         AND created_at < NOW() - ($2 || ' days')::INTERVAL
         AND status != 'draft'
     )
     SELECT
       c.spend AS current_spend,
       c.revenue AS current_revenue,
       c.clicks AS current_clicks,
       c.impressions AS current_impressions,
       c.conversions AS current_conversions,
       p.spend AS previous_spend,
       p.revenue AS previous_revenue,
       p.clicks AS previous_clicks,
       p.impressions AS previous_impressions,
       p.conversions AS previous_conversions,
       CASE WHEN p.spend > 0
         THEN ((c.spend - p.spend) / p.spend) * 100
         ELSE 0
       END AS spend_change_pct,
       CASE WHEN p.revenue > 0
         THEN ((c.revenue - p.revenue) / p.revenue) * 100
         ELSE 0
       END AS revenue_change_pct
     FROM current_period c, previous_period p`,
    [orgId, days]
  );

  return rows[0];
}

/**
 * Get top performing campaigns for an org.
 */
async function getTopCampaigns(orgId, period = '30d', limit = 10) {
  const { interval } = parsePeriod(period);

  const { rows } = await db.query(
    `SELECT
       id, name, platform, status,
       impressions, clicks, conversions, spend, revenue,
       CASE WHEN impressions > 0
         THEN (clicks::NUMERIC / impressions::NUMERIC) * 100
         ELSE 0
       END AS ctr,
       CASE WHEN spend > 0
         THEN revenue / spend
         ELSE 0
       END AS roas,
       created_at
     FROM campaigns
     WHERE org_id = $1
       AND created_at >= NOW() - $2::INTERVAL
       AND status != 'draft'
     ORDER BY revenue DESC
     LIMIT $3`,
    [orgId, interval, limit]
  );

  return rows;
}

/**
 * Get leads over time for charting.
 */
async function getLeadsOverTime(orgId, period = '30d') {
  const { interval } = parsePeriod(period);

  const { rows } = await db.query(
    `SELECT
       DATE(created_at) AS date,
       COUNT(*)::INTEGER AS total,
       COUNT(*) FILTER (WHERE status = 'converted')::INTEGER AS converted
     FROM leads
     WHERE org_id = $1
       AND created_at >= NOW() - $2::INTERVAL
     GROUP BY DATE(created_at)
     ORDER BY date ASC`,
    [orgId, interval]
  );

  return rows;
}

module.exports = {
  getRevenueSummary,
  getLeadMetrics,
  getPlatformBreakdown,
  getDailyMetrics,
  getPeriodComparison,
  getTopCampaigns,
  getLeadsOverTime,
};
