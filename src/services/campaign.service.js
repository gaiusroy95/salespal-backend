const pool = require('../config/db.js');

exports.launchCampaign = async (draftId, userId, orgId) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const draftRes = await client.query(
      'SELECT * FROM campaign_drafts WHERE id = $1 AND org_id = $2 FOR UPDATE',
      [draftId, orgId]
    );
    if (draftRes.rows.length === 0) {
      throw { status: 404, message: 'Draft not found' };
    }
    const draft = draftRes.rows[0];
    const data = draft.draft_data || {};

    const campRes = await client.query(
      `INSERT INTO campaigns 
       (name, description, platform, target_audience, objectives, budget, start_date, end_date, content, metadata, status, launched_at, org_id, user_id, project_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NOW(), $11, $12, $13)
       RETURNING *`,
      [
        data.name || 'Untitled Campaign',
        data.goal || '',
        data.platform || 'sales',
        data.audience ? JSON.stringify(data.audience) : '{}',
        data.objectives ? JSON.stringify(data.objectives) : '{}',
        data.budget || null,
        data.startDate || null,
        data.endDate || null,
        data.content ? JSON.stringify(data.content) : '{}',
        data.metadata ? JSON.stringify(data.metadata) : '{}',
        orgId,
        userId,
        draft.project_id || null
      ]
    );

    await client.query('DELETE FROM campaign_drafts WHERE id = $1', [draftId]);
    await client.query('COMMIT');
    return campRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

exports.createDraft = async (orgId, userId, projectId) => {
  const res = await pool.query(
    `INSERT INTO campaign_drafts (org_id, user_id, project_id, step, draft_data, analysis_done)
     VALUES ($1, $2, $3, 1, '{}', false) 
     RETURNING *`,
    [orgId, userId, projectId || null]
  );
  return res.rows[0];
};

exports.updateDraft = async (draftId, orgId, step, draftData, analysisDone) => {
  const res = await pool.query(
    `UPDATE campaign_drafts 
     SET step = $1, draft_data = draft_data || $2, analysis_done = $3, updated_at = NOW()
     WHERE id = $4 AND org_id = $5 
     RETURNING *`,
    [step, draftData, analysisDone, draftId, orgId]
  );
  return res.rows[0];
};

exports.getDraft = async (draftId, orgId) => {
  const res = await pool.query('SELECT * FROM campaign_drafts WHERE id = $1 AND org_id = $2', [draftId, orgId]);
  return res.rows[0];
};

exports.deleteDraft = async (draftId, orgId) => {
  await pool.query('DELETE FROM campaign_drafts WHERE id = $1 AND org_id = $2', [draftId, orgId]);
};
