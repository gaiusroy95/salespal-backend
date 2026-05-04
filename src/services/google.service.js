'use strict';

const { GoogleAdsApi } = require('google-ads-api');
const { decrypt } = require('./tokenEncryption.service');
const { refreshGoogleToken } = require('../controllers/integrations.controller');
const db = require('../config/db');

// ---------------------------------------------------------------------------
// Period → GAQL date range mapping
// ---------------------------------------------------------------------------
const PERIOD_GAQL_MAP = {
  '7d': 'LAST_7_DAYS',
  '30d': 'LAST_30_DAYS',
  '90d': 'LAST_90_DAYS',
  '1y': 'LAST_YEAR',
};

// ---------------------------------------------------------------------------
// Private: sleep helper
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Private: Google Ads error handler / retry wrapper
// ---------------------------------------------------------------------------
async function gadsRequest(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err?.code || err?.status || '';
      const message = err?.message || String(err);

      // Token expired / unauthenticated
      if (
        status === 'UNAUTHENTICATED' ||
        message.includes('UNAUTHENTICATED') ||
        err?.details?.some?.((d) => d.errors?.some?.((e) => e.errorCode?.authenticationError === 'TWO_STEP_VERIFICATION_NOT_ENROLLED'))
      ) {
        throw { code: 'TOKEN_EXPIRED', platform: 'google', requiresReauth: true };
      }

      // Rate limit / quota exhausted
      if ((status === 'RESOURCE_EXHAUSTED' || message.includes('RESOURCE_EXHAUSTED')) && attempt < retries) {
        await sleep(30_000);
        continue;
      }

      throw { code: 'GOOGLE_ADS_ERROR', message };
    }
  }
}

// ---------------------------------------------------------------------------
// 1. getGoogleAdsClient(userId)
// ---------------------------------------------------------------------------
async function getGoogleAdsClient(userId) {
  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    throw {
      code: 'CONFIG_ERROR',
      message: 'GOOGLE_ADS_DEVELOPER_TOKEN is not configured.',
    };
  }

  const { rows } = await db.query(
    `SELECT access_token_enc, metadata
     FROM integrations
     WHERE user_id = $1
       AND platform = 'google'
       AND status   = 'connected'
     LIMIT 1`,
    [userId]
  );

  if (!rows.length || !rows[0].access_token_enc) {
    throw { code: 'NOT_CONNECTED', message: 'Google Ads is not connected' };
  }

  const refreshToken = decrypt(rows[0].access_token_enc);
  const metadata = rows[0].metadata || {};
  const customerId = metadata.customer_id || null;

  // Exchange refresh token for a fresh access token
  const accessToken = await refreshGoogleToken(refreshToken);

  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  const customer = client.Customer({
    customer_id: customerId,
    refresh_token: refreshToken,
    access_token: accessToken,
  });

  return { customer, customerId, accessToken, refreshToken };
}

// ---------------------------------------------------------------------------
// 2. publishCampaign(userId, campaignData)
// ---------------------------------------------------------------------------
async function publishCampaign(userId, campaignData) {
  const { customer } = await getGoogleAdsClient(userId);

  const dailyBudgetMicros = Math.round((campaignData.dailyBudget || 0) * 1_000_000);

  // Step 1: Create campaign budget
  const budgetRes = await gadsRequest(() =>
    customer.campaignBudgets.create([
      {
        name: `${campaignData.name} Budget`,
        amount_micros: dailyBudgetMicros,
        delivery_method: 2, // STANDARD
      },
    ])
  );
  const campaignBudgetResourceName = budgetRes.results[0].resource_name;

  // Step 2: Create campaign
  const campaignRes = await gadsRequest(() =>
    customer.campaigns.create([
      {
        name: campaignData.name,
        advertising_channel_type: 'SMART',
        status: 'PAUSED',
        campaign_budget: campaignBudgetResourceName,
        ...(campaignData.targetLocations ? { geo_target_type_setting: { positive_geo_target_type: 'PRESENCE_OR_INTEREST' } } : {}),
      },
    ])
  );
  const campaignResourceName = campaignRes.results[0].resource_name;
  const googleCampaignId = campaignResourceName.split('/').pop();

  // Step 3: Create ad group
  const adGroupRes = await gadsRequest(() =>
    customer.adGroups.create([
      {
        name: `${campaignData.name} Ad Group`,
        campaign: campaignResourceName,
        status: 'ENABLED',
        type: 'SMART_CAMPAIGN_ADS',
      },
    ])
  );
  const adGroupResourceName = adGroupRes.results[0].resource_name;
  const adGroupId = adGroupResourceName.split('/').pop();

  // Step 4: Create responsive search ad
  await gadsRequest(() =>
    customer.adGroupAds.create([
      {
        ad_group: adGroupResourceName,
        status: 'PAUSED',
        ad: {
          responsive_search_ad: {
            headlines: [
              { text: campaignData.headline || campaignData.name },
            ],
            descriptions: [
              { text: campaignData.description || '' },
            ],
            final_urls: [],
          },
        },
      },
    ])
  );

  return { googleCampaignId, adGroupId };
}

// ---------------------------------------------------------------------------
// 3. updateCampaignStatus(userId, googleCampaignId, status)
// ---------------------------------------------------------------------------
async function updateCampaignStatus(userId, googleCampaignId, status) {
  const { customer, customerId } = await getGoogleAdsClient(userId);

  return gadsRequest(() =>
    customer.campaigns.update([
      {
        resource_name: `customers/${customerId}/campaigns/${googleCampaignId}`,
        status, // 'ENABLED' | 'PAUSED'
      },
    ])
  );
}

// ---------------------------------------------------------------------------
// 4. getCampaignMetrics(userId, googleCampaignId, period)
// ---------------------------------------------------------------------------
async function getCampaignMetrics(userId, googleCampaignId, period) {
  const { customer } = await getGoogleAdsClient(userId);
  const dateRange = PERIOD_GAQL_MAP[period] || 'LAST_30_DAYS';

  const res = await gadsRequest(() =>
    customer.query(`
      SELECT
        campaign.id,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM campaign
      WHERE campaign.id = ${googleCampaignId}
        AND segments.date DURING ${dateRange}
    `)
  );

  const row = res[0] || {};
  const metrics = row.metrics || {};

  return {
    impressions: Number(metrics.impressions) || 0,
    clicks: Number(metrics.clicks) || 0,
    spend: (Number(metrics.cost_micros) || 0) / 1_000_000,
    conversions: Number(metrics.conversions) || 0,
  };
}

// ---------------------------------------------------------------------------
// 5. getLeadFormSubmissions(userId, campaignId)
// ---------------------------------------------------------------------------
async function getLeadFormSubmissions(userId, campaignId) {
  const { customer } = await getGoogleAdsClient(userId);

  const res = await gadsRequest(() =>
    customer.query(`
      SELECT
        lead_form_submission_data.id,
        lead_form_submission_data.campaign,
        lead_form_submission_data.submission_date_time,
        lead_form_submission_data.lead_form_submission_fields
      FROM lead_form_submission_data
      WHERE lead_form_submission_data.campaign = '${campaignId}'
    `)
  );

  return (res || []).map((row) => {
    const sub = row.lead_form_submission_data || {};
    const fields = {};
    for (const field of sub.lead_form_submission_fields || []) {
      const key = (field.question_type || '').toLowerCase();
      fields[key] = field.field_value;
    }
    return {
      id: sub.id,
      name: fields.full_name || fields.last_name || null,
      email: fields.email || null,
      phone: fields.phone_number || null,
      submittedAt: sub.submission_date_time || null,
    };
  });
}

// ---------------------------------------------------------------------------
// 6. syncGoogleCampaigns(userId, orgId)
//    Pulls all campaigns + 30-day metrics from Google Ads and upserts them
//    into SalesPal's local campaigns table.
// ---------------------------------------------------------------------------
async function syncGoogleCampaigns(userId, orgId) {
  const { customer, customerId } = await getGoogleAdsClient(userId);

  if (!customerId) {
    throw {
      code: 'NO_CUSTOMER_ID',
      message: 'Google Ads Customer ID is not set. Please save it in the integration settings.',
    };
  }

  // Query campaigns + 30-day metrics in a single GAQL call
  const rows = await gadsRequest(() =>
    customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        campaign.advertising_channel_type,
        campaign.start_date,
        campaign.end_date,
        campaign_budget.amount_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.status != 'REMOVED'
    `)
  );

  if (!rows || rows.length === 0) {
    return { synced: 0, skipped: 0 };
  }

  let synced = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const campaign    = row.campaign          || {};
      const budget      = row.campaign_budget   || {};
      const metrics     = row.metrics           || {};

      const googleCampaignId = String(campaign.id || '');
      if (!googleCampaignId) { skipped++; continue; }

      // Map Google Ads status → SalesPal status
      const statusMap = { ENABLED: 'active', PAUSED: 'paused', REMOVED: 'completed' };
      const status = statusMap[campaign.status] || 'paused';

      // Budget: Google stores in micros (1 unit = 1,000,000 micros)
      const dailyBudget = budget.amount_micros
        ? Number(budget.amount_micros) / 1_000_000
        : 0;

      // Metrics
      const impressions  = Number(metrics.impressions)  || 0;
      const clicks       = Number(metrics.clicks)        || 0;
      const spend        = (Number(metrics.cost_micros)  || 0) / 1_000_000;
      const conversions  = Number(metrics.conversions)   || 0;

      await db.query(
        `INSERT INTO campaigns
           (org_id, google_campaign_id, name, platform, status,
            daily_budget, start_date, end_date,
            impressions, clicks, spend, conversions,
            ad_platforms, budget_platforms, budget_split, currency,
            last_synced_at, created_at, updated_at)
         VALUES
           ($1, $2, $3, 'google', $4,
            $5, $6, $7,
            $8, $9, $10, $11,
            '{"google"}', '{"google"}', '{"google":100}', 'USD',
            NOW(), NOW(), NOW())
         ON CONFLICT (google_campaign_id)
         DO UPDATE SET
           name          = EXCLUDED.name,
           status        = EXCLUDED.status,
           daily_budget  = EXCLUDED.daily_budget,
           start_date    = EXCLUDED.start_date,
           end_date      = EXCLUDED.end_date,
           impressions   = EXCLUDED.impressions,
           clicks        = EXCLUDED.clicks,
           spend         = EXCLUDED.spend,
           conversions   = EXCLUDED.conversions,
           last_synced_at = NOW(),
           updated_at    = NOW()`,
        [
          orgId,
          googleCampaignId,
          campaign.name || `Google Campaign ${googleCampaignId}`,
          status,
          dailyBudget,
          campaign.start_date || null,
          campaign.end_date   || null,
          impressions,
          clicks,
          spend,
          conversions,
        ]
      );
      synced++;
    } catch (rowErr) {
      console.error('[google.service] Failed to upsert campaign row:', rowErr);
      skipped++;
    }
  }

  return { synced, skipped, total: rows.length };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getGoogleAdsClient,
  publishCampaign,
  updateCampaignStatus,
  getCampaignMetrics,
  getLeadFormSubmissions,
  syncGoogleCampaigns,
};
