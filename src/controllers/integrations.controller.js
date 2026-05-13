'use strict';

const crypto = require('crypto');
const https = require('https');
const db = require('../config/db');
const env = require('../config/env');
const socialService = require('../services/social.service');
const { encrypt, decrypt } = require('../services/tokenEncryption.service');
const whatsappService = require('../services/whatsapp.service');
const { honorificNameJi } = require('../utils/voiceHonorifics');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOrgId(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

/** In-memory CSRF state store: Map<userId, { state, expiresAt }> */
const _csrfStateStore = new Map();
const CSRF_TTL_MS = 10 * 60 * 1000; // 10 minutes

function storeState(userId, state) {
  _csrfStateStore.set(String(userId), {
    state,
    expiresAt: Date.now() + CSRF_TTL_MS,
  });
}

function verifyAndConsumeState(userId, state) {
  const key = String(userId);
  const stored = _csrfStateStore.get(key);
  _csrfStateStore.delete(key); // consume regardless
  if (!stored) return false;
  if (Date.now() > stored.expiresAt) return false;
  return stored.state === state;
}

/** Perform a GET request and return parsed JSON. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (_e) {
            reject(new Error(`Failed to parse JSON from ${url}: ${raw}`));
          }
        });
      })
      .on('error', reject);
  });
}

/** Perform a POST request with URL-encoded body and return parsed JSON. */
function postJson(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (_e) {
          reject(new Error(`Failed to parse JSON from POST ${url}: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    return new URL(value).origin;
  } catch {
    return String(value).trim().replace(/\/$/, '');
  }
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const s = String(value).trim();
  if (!s) return '';
  try {
    return new URL(s).toString();
  } catch {
    return '';
  }
}

function buildRedirectUriResolver(singleUri, multiUris, callbackPath) {
  const candidates = new Set();
  const add = (value) => {
    const u = normalizeUrl(value);
    if (u) candidates.add(u);
  };
  add(singleUri);
  (Array.isArray(multiUris) ? multiUris : []).forEach(add);
  if (candidates.size === 0) {
    (Array.isArray(env.frontendOrigins) ? env.frontendOrigins : []).forEach((origin) => {
      const normalizedOrigin = normalizeOrigin(origin);
      if (normalizedOrigin) add(`${normalizedOrigin}${callbackPath}`);
    });
  }
  const list = Array.from(candidates);
  const byOrigin = new Map();
  for (const u of list) {
    byOrigin.set(normalizeOrigin(u), u);
  }
  return (req, explicitValue) => {
    const explicit = normalizeUrl(explicitValue);
    if (explicit && candidates.has(explicit)) return explicit;
    const originFromReq = normalizeOrigin(req.headers.origin || req.query.frontendOrigin || req.body?.frontendOrigin);
    if (originFromReq && byOrigin.has(originFromReq)) return byOrigin.get(originFromReq);
    return list[0] || '';
  };
}

// ---------------------------------------------------------------------------
// Existing controllers (unchanged)
// ---------------------------------------------------------------------------

exports.listIntegrations = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ integrations: [] });

    const integrations = await socialService.getIntegrations(orgId);
    res.json({ integrations });
  } catch (err) {
    next(err);
  }
};

exports.upsertIntegration = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId)
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const platform = req.params.platform;
    const { accessToken, access_token_enc, metadata } = req.body;

    const integration = await socialService.upsertIntegration(orgId, req.user.id, platform, {
      accessToken: accessToken || access_token_enc || null,
      metadata: metadata || {},
    });

    res.json({ integration });
  } catch (err) {
    next(err);
  }
};

exports.disconnectIntegration = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId)
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const result = await socialService.disconnectIntegration(orgId, req.params.platform);
    if (!result)
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });

    res.json({ message: `Disconnected ${req.params.platform} successfully` });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Facebook / Meta OAuth controllers
// ---------------------------------------------------------------------------

const FB_API_VERSION = 'v21.0';
const FB_BASE = `https://www.facebook.com/${FB_API_VERSION}`;
const GRAPH_BASE = `https://graph.facebook.com/${FB_API_VERSION}`;
const resolveFacebookRedirectUri = buildRedirectUriResolver(
  env.oauth?.facebookRedirectUri || process.env.FACEBOOK_REDIRECT_URI,
  env.oauth?.facebookRedirectUris || [],
  '/settings/integrations/meta/callback'
);
const resolveInstagramRedirectUri = buildRedirectUriResolver(
  env.oauth?.instagramRedirectUri || process.env.INSTAGRAM_REDIRECT_URI,
  env.oauth?.instagramRedirectUris || [],
  '/settings/integrations/instagram/callback'
);
const FB_SCOPES = [
  'ads_management',
  'ads_read',
  'pages_manage_posts',
  'pages_read_engagement',
  'leads_retrieval',
].join(',');
const IG_SCOPES = [
  'instagram_basic',
  'instagram_manage_insights',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
].join(',');

/**
 * GET /api/integrations/facebook/auth-url
 * Returns the Facebook OAuth dialog URL for this user.
 */
exports.getFacebookAuthUrl = async (req, res, next) => {
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    if (!appId) {
      return res
        .status(500)
        .json({ error: { code: 'CONFIG_ERROR', message: 'FACEBOOK_APP_ID is not configured.' } });
    }

    const state = crypto.randomBytes(24).toString('hex');
    storeState(req.user.id, state);

    const redirectUri = resolveFacebookRedirectUri(req, req.query.redirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'FACEBOOK_REDIRECT_URI(S) are not configured.' } });
    }
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      scope: FB_SCOPES,
      response_type: 'code',
    });

    const authUrl = `${FB_BASE}/dialog/oauth?${params.toString()}`;
    res.json({ authUrl, redirectUri });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/integrations/facebook/callback
 * Handles the OAuth callback, exchanges the code for a long-lived token,
 * fetches ad accounts, and upserts the integration row.
 */
exports.handleFacebookCallback = async (req, res, next) => {
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      return res.status(500).json({
        error: { code: 'CONFIG_ERROR', message: 'Facebook app credentials are not configured.' },
      });
    }

    const { code, state, redirectUri: requestedRedirectUri } = req.body;
    if (!code || !state) {
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'code and state are required.' } });
    }

    // 0. Resolve org
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No organization found for this user.' },
      });
    }

    // 1. Verify CSRF state
    if (!verifyAndConsumeState(req.user.id, state)) {
      return res.status(400).json({
        error: { code: 'INVALID_STATE', message: 'OAuth state mismatch or expired. Please retry.' },
      });
    }

    const redirectUri = resolveFacebookRedirectUri(req, requestedRedirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'FACEBOOK_REDIRECT_URI(S) are not configured.' } });
    }

    // 2. Exchange code → short-lived token
    const shortTokenUrl =
      `${GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      });

    const shortTokenData = await getJson(shortTokenUrl);
    if (!shortTokenData.access_token) {
      return res.status(400).json({
        error: {
          code: 'FB_TOKEN_EXCHANGE_ERROR',
          message: shortTokenData.error?.message || 'Failed to exchange code for token.',
        },
      });
    }
    const shortLivedToken = shortTokenData.access_token;

    // 3. Exchange short-lived → long-lived token
    const longTokenUrl =
      `${GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken,
      });

    const longTokenData = await getJson(longTokenUrl);
    if (!longTokenData.access_token) {
      return res.status(400).json({
        error: {
          code: 'FB_TOKEN_EXCHANGE_ERROR',
          message: longTokenData.error?.message || 'Failed to obtain long-lived token.',
        },
      });
    }
    const longLivedToken = longTokenData.access_token;

    // 4. Fetch ad accounts
    const adAccountsUrl =
      `${GRAPH_BASE}/me/adaccounts?` +
      new URLSearchParams({
        access_token: longLivedToken,
        fields: 'id,name,account_status',
      });

    const adAccountsData = await getJson(adAccountsUrl);
    const adAccounts = adAccountsData.data || [];
    const firstAdAccountId = adAccounts[0]?.id || null;

    // 5. Encrypt long-lived token
    const encryptedToken = encrypt(longLivedToken);

    // 6. Upsert into integrations table (SELECT + INSERT/UPDATE to avoid constraint dependency)
    const metaMetadata = JSON.stringify({ ad_account_id: firstAdAccountId, token_type: 'long_lived' });
    const existingMeta = await db.query(
      `SELECT id FROM integrations WHERE org_id = $1 AND platform = 'meta' LIMIT 1`,
      [orgId]
    );
    if (existingMeta.rows.length > 0) {
      await db.query(
        `UPDATE integrations
         SET status = 'connected', user_id = $1, access_token_enc = $2, metadata = $3, connected_at = NOW()
         WHERE org_id = $4 AND platform = 'meta'`,
        [req.user.id, encryptedToken, metaMetadata, orgId]
      );
    } else {
      await db.query(
        `INSERT INTO integrations (org_id, user_id, platform, status, access_token_enc, metadata, connected_at)
         VALUES ($1, $2, 'meta', 'connected', $3, $4, NOW())`,
        [orgId, req.user.id, encryptedToken, metaMetadata]
      );
    }

    res.json({ success: true, platform: 'meta' });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/integrations/instagram/auth-url
 * Uses Meta OAuth with Instagram-friendly scopes and stores under platform='instagram'.
 */
exports.getInstagramAuthUrl = async (req, res, next) => {
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    if (!appId) {
      return res
        .status(500)
        .json({ error: { code: 'CONFIG_ERROR', message: 'FACEBOOK_APP_ID is not configured.' } });
    }

    const state = crypto.randomBytes(24).toString('hex');
    storeState(req.user.id, state);

    const redirectUri = resolveInstagramRedirectUri(req, req.query.redirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'INSTAGRAM_REDIRECT_URI(S) are not configured.' } });
    }
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      state,
      scope: IG_SCOPES,
      response_type: 'code',
    });

    const authUrl = `${FB_BASE}/dialog/oauth?${params.toString()}`;
    res.json({ authUrl, redirectUri });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/integrations/instagram/callback
 * Completes OAuth and stores token in integrations.platform='instagram'.
 */
exports.handleInstagramCallback = async (req, res, next) => {
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      return res.status(500).json({
        error: { code: 'CONFIG_ERROR', message: 'Facebook app credentials are not configured.' },
      });
    }

    const { code, state, redirectUri: requestedRedirectUri } = req.body;
    if (!code || !state) {
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'code and state are required.' } });
    }

    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No organization found for this user.' },
      });
    }

    if (!verifyAndConsumeState(req.user.id, state)) {
      return res.status(400).json({
        error: { code: 'INVALID_STATE', message: 'OAuth state mismatch or expired. Please retry.' },
      });
    }

    const redirectUri = resolveInstagramRedirectUri(req, requestedRedirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'INSTAGRAM_REDIRECT_URI(S) are not configured.' } });
    }

    const shortTokenUrl =
      `${GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      });
    const shortTokenData = await getJson(shortTokenUrl);
    if (!shortTokenData.access_token) {
      return res.status(400).json({
        error: {
          code: 'IG_TOKEN_EXCHANGE_ERROR',
          message: shortTokenData.error?.message || 'Failed to exchange code for token.',
        },
      });
    }

    const longTokenUrl =
      `${GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortTokenData.access_token,
      });
    const longTokenData = await getJson(longTokenUrl);
    if (!longTokenData.access_token) {
      return res.status(400).json({
        error: {
          code: 'IG_TOKEN_EXCHANGE_ERROR',
          message: longTokenData.error?.message || 'Failed to obtain long-lived token.',
        },
      });
    }

    const encryptedToken = encrypt(longTokenData.access_token);
    const instagramMetadata = JSON.stringify({ token_type: 'long_lived' });

    const existing = await db.query(
      `SELECT id FROM integrations WHERE org_id = $1 AND platform = 'instagram' LIMIT 1`,
      [orgId]
    );
    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE integrations
         SET status = 'connected', user_id = $1, access_token_enc = $2, metadata = $3, connected_at = NOW()
         WHERE org_id = $4 AND platform = 'instagram'`,
        [req.user.id, encryptedToken, instagramMetadata, orgId]
      );
    } else {
      await db.query(
        `INSERT INTO integrations (org_id, user_id, platform, status, access_token_enc, metadata, connected_at)
         VALUES ($1, $2, 'instagram', 'connected', $3, $4, NOW())`,
        [orgId, req.user.id, encryptedToken, instagramMetadata]
      );
    }

    res.json({ success: true, platform: 'instagram' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/integrations/facebook/refresh
 * Refreshes the stored long-lived Facebook token for the authenticated user.
 */
exports.refreshFacebookToken = async (req, res, next) => {
  try {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) {
      return res.status(500).json({
        error: { code: 'CONFIG_ERROR', message: 'Facebook app credentials are not configured.' },
      });
    }

    // 1. Fetch current encrypted token from DB
    const { rows } = await db.query(
      `SELECT access_token_enc FROM integrations
       WHERE user_id = $1 AND platform = 'meta'
       LIMIT 1`,
      [req.user.id]
    );

    if (!rows.length || !rows[0].access_token_enc) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'No Facebook integration found for this user.' },
      });
    }

    // 2. Decrypt current token
    const currentToken = decrypt(rows[0].access_token_enc);

    // 3. Refresh: long-lived tokens are refreshed by exchanging them again
    const refreshUrl =
      `${GRAPH_BASE}/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: currentToken,
      });

    const refreshData = await getJson(refreshUrl);
    if (!refreshData.access_token) {
      return res.status(400).json({
        error: {
          code: 'FB_REFRESH_ERROR',
          message: refreshData.error?.message || 'Failed to refresh Facebook token.',
        },
      });
    }

    // 4. Re-encrypt and persist
    const newEncryptedToken = encrypt(refreshData.access_token);

    await db.query(
      `UPDATE integrations
       SET access_token_enc = $1, connected_at = NOW()
       WHERE user_id = $2 AND platform = 'meta'`,
      [newEncryptedToken, req.user.id]
    );

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Google OAuth controllers
// ---------------------------------------------------------------------------

const GOOGLE_AUTH_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const resolveGoogleRedirectUri = buildRedirectUriResolver(
  env.google?.redirectUri || process.env.GOOGLE_REDIRECT_URI,
  env.google?.redirectUris || [],
  '/settings/integrations/google/callback'
);
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

/**
 * GET /api/integrations/google/auth-url
 * Returns the Google OAuth consent page URL for this user.
 */
exports.getGoogleAuthUrl = async (req, res, next) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return res
        .status(500)
        .json({ error: { code: 'CONFIG_ERROR', message: 'GOOGLE_CLIENT_ID is not configured.' } });
    }

    const state = crypto.randomBytes(24).toString('hex');
    storeState(req.user.id, state);

    const redirectUri = resolveGoogleRedirectUri(req, req.query.redirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'GOOGLE_REDIRECT_URI(S) are not configured.' } });
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES,
      state,
      access_type: 'offline',
      prompt: 'consent', // always return refresh_token
    });

    const authUrl = `${GOOGLE_AUTH_BASE}?${params.toString()}`;
    res.json({ authUrl, redirectUri });
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// LinkedIn OAuth controllers
// ---------------------------------------------------------------------------
const LINKEDIN_AUTH_BASE = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const resolveLinkedInRedirectUri = buildRedirectUriResolver(
  env.oauth?.linkedinRedirectUri || process.env.LINKEDIN_REDIRECT_URI,
  env.oauth?.linkedinRedirectUris || [],
  '/settings/integrations/linkedin/callback'
);
const LINKEDIN_SCOPES = [
  'openid',
  'profile',
  'email',
].join(' ');

exports.getLinkedInAuthUrl = async (req, res, next) => {
  try {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({
        error: { code: 'CONFIG_ERROR', message: 'LINKEDIN_CLIENT_ID is not configured.' },
      });
    }

    const state = crypto.randomBytes(24).toString('hex');
    storeState(req.user.id, state);

    const redirectUri = resolveLinkedInRedirectUri(req, req.query.redirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'LINKEDIN_REDIRECT_URI(S) are not configured.' } });
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: LINKEDIN_SCOPES,
    });
    res.json({ authUrl: `${LINKEDIN_AUTH_BASE}?${params.toString()}`, redirectUri });
  } catch (err) {
    next(err);
  }
};

exports.handleLinkedInCallback = async (req, res, next) => {
  try {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        error: { code: 'CONFIG_ERROR', message: 'LinkedIn credentials are not configured.' },
      });
    }

    const { code, state, redirectUri: requestedRedirectUri } = req.body;
    if (!code || !state) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'code and state are required.' },
      });
    }

    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No organization found for this user.' },
      });
    }

    if (!verifyAndConsumeState(req.user.id, state)) {
      return res.status(400).json({
        error: { code: 'INVALID_STATE', message: 'OAuth state mismatch or expired. Please retry.' },
      });
    }

    const redirectUri = resolveLinkedInRedirectUri(req, requestedRedirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'LINKEDIN_REDIRECT_URI(S) are not configured.' } });
    }

    const tokenData = await postJson(LINKEDIN_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });
    if (!tokenData.access_token) {
      return res.status(400).json({
        error: {
          code: 'LINKEDIN_TOKEN_EXCHANGE_ERROR',
          message: tokenData.error_description || tokenData.error || 'Failed to obtain LinkedIn access token.',
        },
      });
    }

    const encryptedToken = encrypt(tokenData.access_token);
    const linkedInMetadata = JSON.stringify({
      token_type: tokenData.token_type || 'Bearer',
      expires_in: tokenData.expires_in || null,
    });

    const existing = await db.query(
      `SELECT id FROM integrations WHERE org_id = $1 AND platform = 'linkedin' LIMIT 1`,
      [orgId]
    );
    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE integrations
         SET status = 'connected', user_id = $1, access_token_enc = $2, metadata = $3, connected_at = NOW()
         WHERE org_id = $4 AND platform = 'linkedin'`,
        [req.user.id, encryptedToken, linkedInMetadata, orgId]
      );
    } else {
      await db.query(
        `INSERT INTO integrations (org_id, user_id, platform, status, access_token_enc, metadata, connected_at)
         VALUES ($1, $2, 'linkedin', 'connected', $3, $4, NOW())`,
        [orgId, req.user.id, encryptedToken, linkedInMetadata]
      );
    }

    res.json({ success: true, platform: 'linkedin' });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/integrations/google/callback
 * Exchanges the OAuth code for tokens and persists the refresh token.
 */
exports.handleGoogleCallback = async (req, res, next) => {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).json({
        error: { code: 'CONFIG_ERROR', message: 'Google credentials are not configured.' },
      });
    }

    const { code, state, redirectUri: requestedRedirectUri } = req.body;
    if (!code || !state) {
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'code and state are required.' } });
    }

    // 0. Resolve org
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No organization found for this user.' },
      });
    }

    // 1. Verify CSRF state
    if (!verifyAndConsumeState(req.user.id, state)) {
      return res.status(400).json({
        error: { code: 'INVALID_STATE', message: 'OAuth state mismatch or expired. Please retry.' },
      });
    }

    const redirectUri = resolveGoogleRedirectUri(req, requestedRedirectUri);
    if (!redirectUri) {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: 'GOOGLE_REDIRECT_URI(S) are not configured.' } });
    }

    // 2. Exchange code → tokens (access_token + refresh_token)
    const tokenData = await postJson(GOOGLE_TOKEN_URL, {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    if (tokenData.error) {
      return res.status(400).json({
        error: {
          code: 'GOOGLE_TOKEN_EXCHANGE_ERROR',
          message: tokenData.error_description || tokenData.error || 'Failed to exchange code for tokens.',
        },
      });
    }

    const refreshToken = tokenData.refresh_token;
    if (!refreshToken) {
      return res.status(400).json({
        error: {
          code: 'GOOGLE_TOKEN_EXCHANGE_ERROR',
          message: 'No refresh_token returned. Ensure access_type=offline and prompt=consent were set.',
        },
      });
    }

    // 3. Encrypt refresh token and upsert (SELECT + INSERT/UPDATE to avoid constraint dependency)
    const encryptedRefreshToken = encrypt(refreshToken);
    const googleMetadata = JSON.stringify({ customer_id: '', token_type: 'refresh' });

    const existingGoogle = await db.query(
      `SELECT id FROM integrations WHERE org_id = $1 AND platform = 'google' LIMIT 1`,
      [orgId]
    );
    if (existingGoogle.rows.length > 0) {
      await db.query(
        `UPDATE integrations
         SET status = 'connected', user_id = $1, access_token_enc = $2, metadata = $3, connected_at = NOW()
         WHERE org_id = $4 AND platform = 'google'`,
        [req.user.id, encryptedRefreshToken, googleMetadata, orgId]
      );
    } else {
      await db.query(
        `INSERT INTO integrations (org_id, user_id, platform, status, access_token_enc, metadata, connected_at)
         VALUES ($1, $2, 'google', 'connected', $3, $4, NOW())`,
        [orgId, req.user.id, encryptedRefreshToken, googleMetadata]
      );
    }

    res.json({ success: true, platform: 'google' });
  } catch (err) {
    next(err);
  }
};

/**
 * Helper — NOT a route handler.
 * Takes a plaintext refresh token string and returns a fresh access token.
 * Import this in google.service.js:
 *   const { refreshGoogleToken } = require('../controllers/integrations.controller');
 *
 * @param {string} refreshToken - Plaintext (already decrypted) refresh token.
 * @returns {Promise<string>} Fresh access token.
 */
async function refreshGoogleToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not configured.');
  }

  const data = await postJson(GOOGLE_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  if (data.error) {
    throw new Error(
      `Google token refresh failed: ${data.error_description || data.error}`
    );
  }

  if (!data.access_token) {
    throw new Error('Google token refresh returned no access_token.');
  }

  return data.access_token;
}

exports.refreshGoogleToken = refreshGoogleToken;

/**
 * PATCH /api/integrations/google/customer-id
 * Updates only the customer_id in the Google integration metadata.
 */
exports.updateGoogleCustomerId = async (req, res, next) => {
  try {
    const { customerId } = req.body;
    if (!customerId || typeof customerId !== 'string' || !customerId.trim()) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'customerId is required.' },
      });
    }

    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No organization found for this user.' },
      });
    }

    // Merge customer_id into existing metadata without touching the token
    const { rows } = await db.query(
      `UPDATE integrations
       SET metadata = metadata || $1::jsonb, updated_at = NOW()
       WHERE org_id = $2 AND platform = 'google' AND status = 'connected'
       RETURNING id, metadata`,
      [JSON.stringify({ customer_id: customerId.trim().replace(/-/g, '') }), orgId]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Google integration not found or not connected.' },
      });
    }

    res.json({ success: true, metadata: rows[0].metadata });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/integrations/google/sync
 * Syncs all campaigns from Google Ads into the local campaigns table.
 * Requires Google integration to be connected and Customer ID to be set.
 */
exports.syncGoogleCampaigns = async (req, res, next) => {
  try {
    const googleService = require('../services/google.service');

    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'No organization found for this user.' },
      });
    }

    const result = await googleService.syncGoogleCampaigns(req.user.id, orgId);

    res.json({
      success: true,
      message: `Synced ${result.synced} campaign(s) from Google Ads.`,
      ...result,
    });
  } catch (err) {
    // Surface friendly errors for common cases
    if (err.code === 'NOT_CONNECTED') {
      return res.status(400).json({ error: { code: 'NOT_CONNECTED', message: 'Google Ads is not connected. Please connect in settings.' } });
    }
    if (err.code === 'NO_CUSTOMER_ID') {
      return res.status(400).json({ error: { code: 'NO_CUSTOMER_ID', message: err.message } });
    }
    if (err.code === 'TOKEN_EXPIRED') {
      return res.status(401).json({ error: { code: 'TOKEN_EXPIRED', message: 'Google token has expired. Please reconnect in settings.' } });
    }
    if (err.code === 'CONFIG_ERROR') {
      return res.status(500).json({ error: { code: 'CONFIG_ERROR', message: err.message || 'Google Ads is not configured.' } });
    }
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/**
 * GET /api/integrations/health
 * Verifies both Facebook and Google token health for the authenticated user.
 * Returns:
 *   { facebook: { connected, healthy, expiresIn }, google: { connected, healthy } }
 */
exports.checkIntegrationHealth = async (req, res, next) => {
  try {
    const result = {
      facebook: { connected: false, healthy: false, expiresIn: null },
      google:   { connected: false, healthy: false },
    };

    // ── Facebook check ───────────────────────────────────────────────────────
    const { rows: fbRows } = await db.query(
      `SELECT access_token_enc, metadata
       FROM integrations
       WHERE user_id = $1 AND platform = 'meta' AND status = 'connected'
       LIMIT 1`,
      [req.user.id]
    );

    if (fbRows.length && fbRows[0].access_token_enc) {
      result.facebook.connected = true;
      const meta = fbRows[0].metadata || {};

      // Estimate days remaining (long-lived tokens last ~60 days from issue date)
      if (meta.token_issued_at) {
        const issuedMs    = new Date(meta.token_issued_at).getTime();
        const ageMs       = Date.now() - issuedMs;
        const maxMs       = 60 * 24 * 60 * 60 * 1000;
        const remainingMs = maxMs - ageMs;
        result.facebook.expiresIn = Math.max(0, Math.floor(remainingMs / (24 * 60 * 60 * 1000))); // days
      }

      try {
        const token = decrypt(fbRows[0].access_token_enc);
        const verifyUrl = `${GRAPH_BASE}/me?fields=id&access_token=${encodeURIComponent(token)}`;
        const verifyData = await getJson(verifyUrl);
        result.facebook.healthy = Boolean(verifyData?.id && !verifyData?.error);
      } catch {
        result.facebook.healthy = false;
      }
    }

    // ── Google check ────────────────────────────────────────────────────────
    const { rows: gRows } = await db.query(
      `SELECT access_token_enc
       FROM integrations
       WHERE user_id = $1 AND platform = 'google' AND status = 'connected'
       LIMIT 1`,
      [req.user.id]
    );

    if (gRows.length && gRows[0].access_token_enc) {
      result.google.connected = true;
      try {
        const refreshToken = decrypt(gRows[0].access_token_enc);
        // A successful token refresh proves the refresh token is still valid
        await refreshGoogleToken(refreshToken);
        result.google.healthy = true;
      } catch {
        result.google.healthy = false;
      }
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /integrations/readiness
 * Validates whether SalesPal can run:
 * 1) Calling solution (AI voice runtime)
 * 2) Google Ads creation/sync flow
 *
 * This endpoint is intentionally operational: it checks config + integration state
 * and returns actionable blockers to help teams go live faster.
 */
exports.checkSalesPalReadiness = async (req, res, next) => {
  try {
    const checks = {
      calling: {
        ready: false,
        checks: {
          aiApiConfigured: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
          voiceTablesPresent: false,
        },
      },
      adsCreation: {
        ready: false,
        checks: {
          googleOAuthConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
          googleDeveloperTokenConfigured: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
          googleConnected: false,
          customerIdSet: false,
          tokenHealthy: false,
        },
      },
      blockers: [],
    };

    // Validate voice runtime schema presence
    const { rows: voiceSchemaRows } = await db.query(
      `SELECT EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'ai_voice_sessions'
       ) AS has_voice_sessions,
       EXISTS (
         SELECT 1
         FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'ai_voice_turns'
       ) AS has_voice_turns`
    );
    const hasVoiceSessions = Boolean(voiceSchemaRows[0]?.has_voice_sessions);
    const hasVoiceTurns = Boolean(voiceSchemaRows[0]?.has_voice_turns);
    checks.calling.checks.voiceTablesPresent = hasVoiceSessions && hasVoiceTurns;

    // Validate Google connection state for current user
    const { rows: googleRows } = await db.query(
      `SELECT access_token_enc, metadata
       FROM integrations
       WHERE user_id = $1
         AND platform = 'google'
         AND status = 'connected'
       LIMIT 1`,
      [req.user.id]
    );

    const googleRow = googleRows[0];
    if (googleRow?.access_token_enc) {
      checks.adsCreation.checks.googleConnected = true;
      const metadata = googleRow.metadata || {};
      checks.adsCreation.checks.customerIdSet = Boolean(String(metadata.customer_id || '').trim());

      try {
        const refreshToken = decrypt(googleRow.access_token_enc);
        await refreshGoogleToken(refreshToken);
        checks.adsCreation.checks.tokenHealthy = true;
      } catch {
        checks.adsCreation.checks.tokenHealthy = false;
      }
    }

    checks.calling.ready =
      checks.calling.checks.aiApiConfigured &&
      checks.calling.checks.voiceTablesPresent;

    checks.adsCreation.ready =
      checks.adsCreation.checks.googleOAuthConfigured &&
      checks.adsCreation.checks.googleDeveloperTokenConfigured &&
      checks.adsCreation.checks.googleConnected &&
      checks.adsCreation.checks.customerIdSet &&
      checks.adsCreation.checks.tokenHealthy;

    if (!checks.calling.checks.aiApiConfigured) {
      checks.blockers.push('Set GOOGLE_GENERATIVE_AI_API_KEY to enable AI calling runtime.');
    }
    if (!checks.calling.checks.voiceTablesPresent) {
      checks.blockers.push('Run DB migrations to create ai_voice_sessions and ai_voice_turns tables.');
    }
    if (!checks.adsCreation.checks.googleOAuthConfigured) {
      checks.blockers.push('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    }
    if (!checks.adsCreation.checks.googleDeveloperTokenConfigured) {
      checks.blockers.push('Set GOOGLE_ADS_DEVELOPER_TOKEN.');
    }
    if (!checks.adsCreation.checks.googleConnected) {
      checks.blockers.push('Connect Google Ads from Integrations settings.');
    } else {
      if (!checks.adsCreation.checks.customerIdSet) {
        checks.blockers.push('Save Google Ads Customer ID in integration settings.');
      }
      if (!checks.adsCreation.checks.tokenHealthy) {
        checks.blockers.push('Reconnect Google Ads; stored token is unhealthy.');
      }
    }

    const overallReady = checks.calling.ready && checks.adsCreation.ready;
    res.json({
      success: true,
      overallReady,
      ...checks,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /integrations/deployed-numbers
 * Returns centrally managed bot sender numbers for calling/whatsapp.
 */
exports.listDeployedNumbers = async (req, res, next) => {
  try {
    const fallback = {
      calling: ['+91 98765 43210', '+91 91234 56789', '+1 415 555 0134'],
      whatsapp: ['+91 98765 43210', '+91 91234 56789', '+1 415 555 0134'],
    };

    const { rows } = await db.query(
      `SELECT value FROM platform_settings WHERE key = 'deployed_numbers' LIMIT 1`
    );
    const cfg = rows[0]?.value && typeof rows[0].value === 'object' ? rows[0].value : {};
    let calling = Array.isArray(cfg.calling) && cfg.calling.length ? [...cfg.calling] : [...fallback.calling];
    const whatsapp = Array.isArray(cfg.whatsapp) && cfg.whatsapp.length ? cfg.whatsapp : fallback.whatsapp;

    // Tata outbound caller ID must match TATA_CALL_FROM_NUMBER from server env (exact string as configured).
    const tataFrom = String(env.telephony?.fromNumber || '').trim();
    if (tataFrom) {
      const norm = (s) => String(s || '').replace(/\D/g, '');
      const tNorm = norm(tataFrom);
      calling = calling.filter((n) => norm(n) !== tNorm);
      calling.unshift(tataFrom);
    }

    res.json({
      calling,
      whatsapp,
      tataCallFromNumber: tataFrom || null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /integrations/whatsapp/send-template
 * Workflow A: server-side dispatch of an approved catalogue / asset template.
 */
exports.postWhatsAppSendTemplate = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) {
      return res.status(400).json({ error: { code: 'ORG_REQUIRED', message: 'User must belong to an organization' } });
    }
    const body = req.body || {};
    const leadId = body.lead_id || body.leadId || null;
    let to = String(body.to || body.phone || '').trim();
    let leadName = '';

    if (leadId) {
      const { rows } = await db.query(
        `SELECT contact_phone, contact_first_name, contact_last_name FROM leads WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [leadId, orgId]
      );
      const lead = rows[0];
      if (!lead) return res.status(404).json({ error: { code: 'LEAD_NOT_FOUND', message: 'Lead not found' } });
      leadName = `${lead.contact_first_name || ''} ${lead.contact_last_name || ''}`.trim();
      if (!to) to = lead.contact_phone || '';
    }

    if (!to) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'destination phone (to) or leadId is required' } });
    }

    const assetId = body.asset_id != null ? String(body.asset_id).trim() : body.assetId != null ? String(body.assetId).trim() : '';
    const templateName = String(body.template_name || body.templateName || env.whatsapp.catalogueTemplateName || '').trim();
    const languageCode = String(body.language_code || body.languageCode || env.whatsapp.catalogueTemplateLang || 'en').trim() || 'en';
    let bodyParameters = body.body_parameters || body.bodyParameters || [];
    if (!Array.isArray(bodyParameters)) bodyParameters = [];
    const headerDocument = body.header_document || body.headerDocument || null;

    const ji = honorificNameJi(leadName) || 'Sir / Maam';
    if (!bodyParameters.length && assetId) bodyParameters = [ji, assetId];
    if (!bodyParameters.length && leadName) bodyParameters = [ji];

    if (!templateName) {
      return res.status(400).json({
        error: {
          code: 'TEMPLATE_NAME_REQUIRED',
          message: 'Provide template_name or configure WHATSAPP_TEMPLATE_PROJECT_CATALOG in .env',
        },
      });
    }
    if (!whatsappService.isWhatsAppEnabled()) {
      return res.status(503).json({ error: { code: 'WHATSAPP_NOT_CONFIGURED', message: 'WhatsApp Cloud API not configured' } });
    }

    const sent = await whatsappService.sendWhatsAppTemplate({
      to,
      templateName,
      languageCode,
      bodyParameters,
      headerDocument: headerDocument?.link ? headerDocument : null,
    });

    res.status(201).json({
      ok: true,
      messageId: sent.messageId,
      template: templateName,
      asset_id: assetId || null,
    });
  } catch (err) {
    next(err);
  }
};
