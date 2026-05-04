'use strict';

const axios = require('axios');
const { decrypt } = require('./tokenEncryption.service');
const db = require('../config/db');

const FB_API_BASE = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------
// Period → Facebook date_preset mapping
// ---------------------------------------------------------------------------
const PERIOD_PRESET_MAP = {
  '7d': 'last_7d',
  '30d': 'last_30d',
  '90d': 'last_90d',
  '1y': 'last_year',
};

// ---------------------------------------------------------------------------
// Private: sleep helper for rate-limit retries
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Private: Facebook error handler / retry wrapper
// ---------------------------------------------------------------------------
async function fbRequest(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const fbError = err?.response?.data?.error;
      const fbCode = fbError?.code;

      // Token expired — requires re-auth, no retry
      if (fbCode === 190) {
        throw { code: 'TOKEN_EXPIRED', platform: 'facebook', requiresReauth: true };
      }

      // Rate limit — retry after 60 s
      if ((fbCode === 17 || fbCode === 32) && attempt < retries) {
        await sleep(60_000);
        continue;
      }

      // All other errors
      throw {
        code: 'FACEBOOK_API_ERROR',
        message: fbError?.message || err.message || 'Unknown Facebook API error',
        fbErrorCode: fbCode ?? null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// 1. getDecryptedToken(userId)
// ---------------------------------------------------------------------------
const { encrypt } = require('./tokenEncryption.service');

const FB_TOKEN_MAX_AGE_MS = 50 * 24 * 60 * 60 * 1000; // 50 days in ms

async function getDecryptedToken(userId) {
  const { rows } = await db.query(
    `SELECT access_token_enc, metadata
     FROM integrations
     WHERE user_id = $1
       AND platform = 'meta'
       AND status   = 'connected'
     LIMIT 1`,
    [userId]
  );

  if (!rows.length || !rows[0].access_token_enc) {
    throw { code: 'NOT_CONNECTED', message: 'Facebook is not connected' };
  }

  let token = decrypt(rows[0].access_token_enc);
  const metadata = rows[0].metadata || {};

  // ── Proactive token refresh if token age > 50 days ──────────────────────
  const issuedAt = metadata.token_issued_at ? new Date(metadata.token_issued_at).getTime() : 0;
  const tokenAgeMs = Date.now() - issuedAt;

  if (tokenAgeMs > FB_TOKEN_MAX_AGE_MS) {
    try {
      const appId     = process.env.FACEBOOK_APP_ID;
      const appSecret = process.env.FACEBOOK_APP_SECRET;

      if (appId && appSecret) {
        const refreshUrl =
          `${FB_API_BASE}/oauth/access_token?` +
          new URLSearchParams({
            grant_type:       'fb_exchange_token',
            client_id:        appId,
            client_secret:    appSecret,
            fb_exchange_token: token,
          });

        const res = await axios.get(refreshUrl);
        const newToken = res.data?.access_token;

        if (newToken) {
          token = newToken;
          const newEncrypted = encrypt(newToken);
          const newMeta = {
            ...metadata,
            token_issued_at: new Date().toISOString(),
          };

          // Fire-and-forget DB update (non-blocking for caller)
          db.query(
            `UPDATE integrations
             SET access_token_enc = $1, metadata = $2
             WHERE user_id = $3 AND platform = 'meta'`,
            [newEncrypted, JSON.stringify(newMeta), userId]
          ).catch((e) => console.warn('[fb.service] Token refresh DB update failed:', e.message));
        }
      }
    } catch (refreshErr) {
      // Token refresh failed — continue with the existing token; it may still be valid
      console.warn('[fb.service] Proactive token refresh failed:', refreshErr?.message || refreshErr);
    }
  }

  return {
    token,
    adAccountId: metadata.ad_account_id || null,
    pageId:      metadata.page_id       || null,
  };
}

// ---------------------------------------------------------------------------
// 2. publishCampaign(userId, campaignData)
// ---------------------------------------------------------------------------
async function publishCampaign(userId, campaignData) {
  const { token, adAccountId } = await getDecryptedToken(userId);
  if (!adAccountId) {
    throw { code: 'FACEBOOK_API_ERROR', message: 'No ad account ID found for this integration.' };
  }

  const actPath = `act_${adAccountId}`;
  const headers = { Authorization: `Bearer ${token}` };

  // Step 1: Create campaign
  const campaignRes = await fbRequest(() =>
    axios.post(
      `${FB_API_BASE}/${actPath}/campaigns`,
      {
        name: campaignData.name,
        objective: campaignData.objective || 'OUTCOME_LEADS',
        status: 'PAUSED',
        special_ad_categories: [],
      },
      { headers }
    )
  );
  const facebookCampaignId = campaignRes.data.id;

  // Step 2: Create ad set
  const adSetRes = await fbRequest(() =>
    axios.post(
      `${FB_API_BASE}/${actPath}/adsets`,
      {
        name: `${campaignData.name} Ad Set`,
        campaign_id: facebookCampaignId,
        daily_budget: Math.round((campaignData.dailyBudget || 0) * 100), // dollars → cents
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LEAD_GENERATION',
        targeting: campaignData.targeting || {
          age_min: 18,
          age_max: 65,
          geo_locations: { countries: ['IN'] },
        },
        status: 'PAUSED',
        ...(campaignData.startTime ? { start_time: campaignData.startTime } : {}),
        ...(campaignData.endTime ? { end_time: campaignData.endTime } : {}),
      },
      { headers }
    )
  );
  const adSetId = adSetRes.data.id;

  // Step 3: Create ad
  const adRes = await fbRequest(() =>
    axios.post(
      `${FB_API_BASE}/${actPath}/ads`,
      {
        name: `${campaignData.name} Ad`,
        adset_id: adSetId,
        creative: {
          title: campaignData.adCreative?.headline || campaignData.name,
          body: campaignData.adCreative?.description || '',
          call_to_action_type: 'LEARN_MORE',
        },
        status: 'PAUSED',
      },
      { headers }
    )
  );
  const adId = adRes.data.id;

  return { facebookCampaignId, adSetId, adId };
}

// ---------------------------------------------------------------------------
// 3. updateCampaignStatus(userId, facebookCampaignId, status)
// ---------------------------------------------------------------------------
async function updateCampaignStatus(userId, facebookCampaignId, status) {
  const { token } = await getDecryptedToken(userId);

  return fbRequest(() =>
    axios.post(
      `${FB_API_BASE}/${facebookCampaignId}`,
      { status },
      { headers: { Authorization: `Bearer ${token}` } }
    )
  );
}

// ---------------------------------------------------------------------------
// 4. getCampaignInsights(userId, facebookCampaignId, period)
// ---------------------------------------------------------------------------
async function getCampaignInsights(userId, facebookCampaignId, period) {
  const { token } = await getDecryptedToken(userId);
  const datePreset = PERIOD_PRESET_MAP[period] || 'last_30d';

  const res = await fbRequest(() =>
    axios.get(`${FB_API_BASE}/${facebookCampaignId}/insights`, {
      params: {
        fields: 'impressions,clicks,spend,reach,cpm,cpc,ctr',
        date_preset: datePreset,
      },
      headers: { Authorization: `Bearer ${token}` },
    })
  );

  const raw = res.data?.data?.[0] || {};
  return {
    impressions: Number(raw.impressions) || 0,
    clicks: Number(raw.clicks) || 0,
    spend: Number(raw.spend) || 0,
    reach: Number(raw.reach) || 0,
    cpm: Number(raw.cpm) || 0,
    cpc: Number(raw.cpc) || 0,
    ctr: Number(raw.ctr) || 0,
  };
}

// ---------------------------------------------------------------------------
// 5. createLeadGenForm(userId, pageId, formData)
// ---------------------------------------------------------------------------
async function createLeadGenForm(userId, pageId, formData) {
  const { token } = await getDecryptedToken(userId);

  const res = await fbRequest(() =>
    axios.post(
      `${FB_API_BASE}/${pageId}/leadgen_forms`,
      {
        name: formData.name,
        questions: formData.questions || [],
        privacy_policy: { url: 'https://your-privacy-url.com' },
        follow_up_action_url: '',
      },
      { headers: { Authorization: `Bearer ${token}` } }
    )
  );

  return { leadGenFormId: res.data.id };
}

// ---------------------------------------------------------------------------
// 6. getLeadsFromForm(userId, leadGenFormId)
// ---------------------------------------------------------------------------
async function getLeadsFromForm(userId, leadGenFormId) {
  const { token } = await getDecryptedToken(userId);

  const res = await fbRequest(() =>
    axios.get(`${FB_API_BASE}/${leadGenFormId}/leads`, {
      params: { fields: 'field_data,created_time' },
      headers: { Authorization: `Bearer ${token}` },
    })
  );

  const rawLeads = res.data?.data || [];

  return rawLeads.map((lead) => {
    const fields = {};
    if (Array.isArray(lead.field_data)) {
      for (const field of lead.field_data) {
        const key = (field.name || '').toLowerCase().replace(/\s+/g, '_');
        fields[key] = Array.isArray(field.values) ? field.values[0] : field.values;
      }
    }

    return {
      id: lead.id,
      createdTime: lead.created_time,
      name: fields.full_name || fields.name || null,
      email: fields.email || null,
      phone: fields.phone_number || fields.phone || null,
      raw: fields,
    };
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  getDecryptedToken,
  publishCampaign,
  updateCampaignStatus,
  getCampaignInsights,
  createLeadGenForm,
  getLeadsFromForm,
};
