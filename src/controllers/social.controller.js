const db = require('../config/db');
const socialService = require('../services/social.service');

async function getOrgId(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

// ─── Posts ───────────────────────────────────────────────────────────────────

async function listPosts(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    const { platform, status, projectId, limit = 50, offset = 0 } = req.query;
    const posts = await socialService.listPosts(orgId, { platform, status, projectId, limit, offset });
    res.json(posts);
  } catch (err) {
    next(err);
  }
}

async function getPost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });

    const post = await socialService.getPost(req.params.id, orgId);
    if (!post) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    res.json(post);
  } catch (err) {
    next(err);
  }
}

async function createPost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    // Accept both camelCase and snake_case from frontend
    const {
      platform,
      content,
      mediaUrl, media_url,
      status,
      scheduledAt, scheduled_at,
      projectId, project_id,
      metrics,
    } = req.body;

    const post = await socialService.createPost(orgId, req.user.id, {
      platform,
      content,
      mediaUrl: mediaUrl || media_url,
      status,
      scheduledAt: scheduledAt || scheduled_at,
      projectId: projectId || project_id,
      metrics,
    });

    res.status(201).json(post);
  } catch (err) {
    next(err);
  }
}

async function updatePost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });

    const {
      platform,
      content,
      mediaUrl, media_url,
      status,
      scheduledAt, scheduled_at,
      publishedAt, published_at,
      projectId, project_id,
      metrics,
    } = req.body;

    const updated = await socialService.updatePost(req.params.id, orgId, {
      platform,
      content,
      mediaUrl: mediaUrl || media_url,
      status,
      scheduledAt: scheduledAt || scheduled_at,
      publishedAt: publishedAt || published_at,
      projectId: projectId || project_id,
      metrics,
    });

    if (!updated) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

async function deletePost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });

    const deleted = await socialService.deletePost(req.params.id, orgId);
    if (!deleted) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    res.json({ message: 'Post deleted' });
  } catch (err) {
    next(err);
  }
}

// ─── Integrations ────────────────────────────────────────────────────────────

async function listIntegrations(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    const integrations = await socialService.getIntegrations(orgId);
    res.json(integrations);
  } catch (err) {
    next(err);
  }
}

async function connectIntegration(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { platform, accessToken, metadata } = req.body;
    if (!platform) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'platform is required' } });

    const integration = await socialService.upsertIntegration(orgId, req.user.id, platform, {
      accessToken: accessToken || null,
      metadata: metadata || {},
    });

    res.json(integration);
  } catch (err) {
    next(err);
  }
}

async function disconnectIntegration(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });

    const result = await socialService.disconnectIntegration(orgId, req.params.platform);
    if (!result) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found' } });
    res.json({ message: 'Integration disconnected', platform: req.params.platform });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  listIntegrations,
  connectIntegration,
  disconnectIntegration,
};
