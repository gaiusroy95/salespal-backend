const db = require('../config/db');
const logger = require('../config/logger');

/**
 * Get all social posts for an org, with optional filters.
 */
async function listPosts(orgId, { platform, status, projectId, limit = 50, offset = 0 } = {}) {
  let sql = `SELECT * FROM social_posts WHERE org_id = $1`;
  const params = [orgId];
  let idx = 2;

  if (platform) { sql += ` AND platform = $${idx++}`; params.push(platform); }
  if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
  if (projectId) { sql += ` AND project_id = $${idx++}`; params.push(projectId); }

  sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(parseInt(limit), parseInt(offset));

  const { rows } = await db.query(sql, params);
  return rows;
}

/**
 * Get a single post by ID.
 */
async function getPost(postId, orgId) {
  const { rows } = await db.query(
    `SELECT * FROM social_posts WHERE id = $1 AND org_id = $2`,
    [postId, orgId]
  );
  return rows[0] || null;
}

/**
 * Create a new social post.
 */
async function createPost(orgId, userId, data) {
  const {
    platform,
    content,
    mediaUrl,
    status = 'draft',
    scheduledAt,
    projectId,
    metrics,
  } = data;

  const { rows } = await db.query(
    `INSERT INTO social_posts
       (org_id, user_id, project_id, platform, content, media_url, status, scheduled_at, metrics)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      orgId,
      userId,
      projectId || null,
      platform || null,
      content || null,
      mediaUrl || null,
      status,
      scheduledAt || null,
      metrics ? JSON.stringify(metrics) : '{}',
    ]
  );

  logger.info(`Social post created: ${rows[0].id} org=${orgId}`);
  return rows[0];
}

/**
 * Update a social post.
 */
async function updatePost(postId, orgId, updates) {
  const allowed = {
    platform: 'platform',
    content: 'content',
    mediaUrl: 'media_url',
    status: 'status',
    scheduledAt: 'scheduled_at',
    publishedAt: 'published_at',
    projectId: 'project_id',
    metrics: 'metrics',
  };

  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, col] of Object.entries(allowed)) {
    if (updates[key] !== undefined) {
      sets.push(`${col} = $${idx++}`);
      vals.push(col === 'metrics' ? JSON.stringify(updates[key]) : updates[key]);
    }
  }

  if (sets.length === 0) return null;

  sets.push(`updated_at = NOW()`);
  vals.push(postId, orgId);

  const { rows } = await db.query(
    `UPDATE social_posts SET ${sets.join(', ')} WHERE id = $${idx++} AND org_id = $${idx} RETURNING *`,
    vals
  );
  return rows[0] || null;
}

/**
 * Delete a social post.
 */
async function deletePost(postId, orgId) {
  const { rowCount } = await db.query(
    `DELETE FROM social_posts WHERE id = $1 AND org_id = $2`,
    [postId, orgId]
  );
  return rowCount > 0;
}

/**
 * Get all integrations for an org.
 */
async function getIntegrations(orgId) {
  const { rows } = await db.query(
    `SELECT id, org_id, user_id, platform, status, metadata, connected_at, created_at, updated_at
     FROM integrations
     WHERE org_id = $1
     ORDER BY platform ASC`,
    [orgId]
  );
  return rows;
}

/**
 * Upsert an integration (connect/update).
 */
async function upsertIntegration(orgId, userId, platform, { accessToken, metadata = {} } = {}) {
  const { rows } = await db.query(
    `INSERT INTO integrations (org_id, user_id, platform, status, access_token_enc, metadata, connected_at)
     VALUES ($1, $2, $3, 'connected', $4, $5, NOW())
     ON CONFLICT (org_id, platform) DO UPDATE
       SET status = 'connected',
           access_token_enc = EXCLUDED.access_token_enc,
           metadata = EXCLUDED.metadata,
           connected_at = NOW(),
           updated_at = NOW()
     RETURNING id, org_id, user_id, platform, status, metadata, connected_at`,
    [orgId, userId, platform, accessToken || null, JSON.stringify(metadata)]
  );
  return rows[0];
}

/**
 * Disconnect an integration.
 */
async function disconnectIntegration(orgId, platform) {
  const { rows } = await db.query(
    `UPDATE integrations
     SET status = 'disconnected', access_token_enc = NULL, updated_at = NOW()
     WHERE org_id = $1 AND platform = $2
     RETURNING *`,
    [orgId, platform]
  );
  return rows[0] || null;
}

module.exports = {
  listPosts,
  getPost,
  createPost,
  updatePost,
  deletePost,
  getIntegrations,
  upsertIntegration,
  disconnectIntegration,
};
