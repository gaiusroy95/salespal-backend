const db = require('../config/db');
const {
  extractWebsiteKnowledge,
  extractPdfKnowledge,
  extractBusinessKnowledge,
  extractLogoKnowledge,
  extractPlainTextKnowledge,
  extractDriveLinkKnowledge,
  extractWebpageKnowledge,
  buildKnowledgeRows,
  retrieveTopKSql,
  vecToSql,
  reindexProjectEmbeddings,
} = require('../services/projectKnowledge.service');

function normalizeWebsiteUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withScheme);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    // host must include at least one dot, unless localhost
    const host = parsed.hostname.toLowerCase();
    if (host !== 'localhost' && !host.includes('.')) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

function presentProject(row) {
  if (!row) return row;
  const metadata = row.metadata || {};
  return {
    ...row,
    website: metadata.website || null,
  };
}

async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

async function listProjects(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    const { status, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT * FROM projects WHERE org_id = $1`;
    const params = [orgId];
    let idx = 2;

    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }

    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(sql, params);
    res.json(rows.map(presentProject));
  } catch (err) {
    next(err);
  }
}

async function getProject(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM projects WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    res.json(presentProject(rows[0]));
  } catch (err) {
    next(err);
  }
}

async function createProject(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { name, description, industry, website, metadata } = req.body;
    const normalizedWebsite = website !== undefined ? normalizeWebsiteUrl(website) : null;
    if (website !== undefined && !normalizedWebsite) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Please provide a valid website URL.' },
      });
    }
    const mergedMetadata = {
      ...(metadata || {}),
      ...(normalizedWebsite ? { website: normalizedWebsite } : {}),
    };

    const { rows } = await db.query(
      `INSERT INTO projects (org_id, user_id, name, description, industry, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [orgId, req.user.id, name, description, industry, JSON.stringify(mergedMetadata)]
    );
    res.status(201).json(presentProject(rows[0]));
  } catch (err) {
    next(err);
  }
}

async function updateProject(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { name, description, status, industry, website, metadata } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (name !== undefined) { updates.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { updates.push(`description = $${idx++}`); values.push(description); }
    if (status !== undefined) { updates.push(`status = $${idx++}`); values.push(status); }
    if (industry !== undefined) { updates.push(`industry = $${idx++}`); values.push(industry); }
    if (metadata !== undefined || website !== undefined) {
      const existing = await db.query(
        `SELECT metadata FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [req.params.id, orgId]
      );
      if (!existing.rows[0]) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      const existingMetadata = existing.rows[0].metadata || {};
      const nextMetadata = { ...existingMetadata, ...(metadata || {}) };
      if (website !== undefined) {
        const normalizedWebsite = normalizeWebsiteUrl(website);
        if (!normalizedWebsite) {
          return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: 'Please provide a valid website URL.' },
          });
        }
        nextMetadata.website = normalizedWebsite;
      }
      updates.push(`metadata = $${idx++}`);
      values.push(JSON.stringify(nextMetadata));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id, orgId);

    const { rows } = await db.query(
      `UPDATE projects SET ${updates.join(', ')} WHERE id = $${idx++} AND org_id = $${idx} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    res.json(presentProject(rows[0]));
  } catch (err) {
    next(err);
  }
}

async function archiveProject(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `UPDATE projects SET status = 'archived', updated_at = NOW() WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    res.json(presentProject(rows[0]));
  } catch (err) {
    next(err);
  }
}

async function deleteProject(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rowCount } = await db.query(
      `DELETE FROM projects WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    res.json({ message: 'Project deleted' });
  } catch (err) {
    next(err);
  }
}

async function ingestProjectKnowledge(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const projectId = req.params.id;
    const projectRes = await db.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`, [projectId, orgId]);
    if (!projectRes.rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });

    const body = req.body || {};
    const {
      websiteUrl,
      webpageUrl,
      businessDescription,
      textBody,
      textTitle,
      driveUrl,
      driveNotes,
    } = body;
    const files = Array.isArray(req.files) ? req.files : [];
    const extracted = [];

    const site = normalizeWebsiteUrl(websiteUrl);
    if (site) extracted.push(await extractWebsiteKnowledge(site));

    const page = normalizeWebsiteUrl(webpageUrl);
    if (page && page !== site) extracted.push(await extractWebpageKnowledge(page));

    if (businessDescription) extracted.push(extractBusinessKnowledge(businessDescription));

    const txt = String(textBody || '').trim();
    if (txt) extracted.push(extractPlainTextKnowledge(textTitle, txt));

    const drive = String(driveUrl || '').trim();
    if (drive) extracted.push(extractDriveLinkKnowledge(drive, driveNotes));

    for (const f of files) {
      if ((f.mimetype || '').includes('pdf')) extracted.push(await extractPdfKnowledge(f));
      if ((f.mimetype || '').startsWith('image/')) extracted.push(extractLogoKnowledge(f));
    }
    if (!extracted.length) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No ingest input provided' } });
    }

    const latest = await db.query(
      `SELECT COALESCE(MAX(knowledge_version), 0) AS v FROM project_knowledge WHERE project_id = $1`,
      [projectId]
    );
    const nextVersion = Number(latest.rows[0]?.v || 0) + 1;

    let inserted = 0;
    for (const item of extracted) {
      const rows = await buildKnowledgeRows(item);
      for (const r of rows) {
        const embJson = JSON.stringify(r.embedding);
        const vecStr = vecToSql(r.embedding);
        try {
          await db.query(
            `INSERT INTO project_knowledge
             (project_id, org_id, source_type, source_name, content, embedding, embedding_vec, metadata, knowledge_version, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8,$9,$10)`,
            [projectId, orgId, r.sourceType, r.sourceName, r.content, embJson, vecStr, JSON.stringify(r.metadata || {}), nextVersion, req.user.id]
          );
        } catch (_vecErr) {
          await db.query(
            `INSERT INTO project_knowledge
             (project_id, org_id, source_type, source_name, content, embedding, metadata, knowledge_version, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [projectId, orgId, r.sourceType, r.sourceName, r.content, embJson, JSON.stringify(r.metadata || {}), nextVersion, req.user.id]
          );
        }
        inserted += 1;
      }
    }

    return res.status(201).json({ success: true, insertedChunks: inserted, knowledgeVersion: nextVersion });
  } catch (err) {
    next(err);
  }
}

async function listProjectBrainDrive(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const projectId = req.params.id;
    const projectRes = await db.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`, [projectId, orgId]);
    if (!projectRes.rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });

    const { rows } = await db.query(
      `SELECT source_type, source_name, COUNT(*)::int AS chunk_count, MAX(created_at) AS last_ingested_at
       FROM project_knowledge
       WHERE project_id = $1 AND org_id = $2
       GROUP BY source_type, source_name
       ORDER BY MAX(created_at) DESC
       LIMIT 200`,
      [projectId, orgId]
    );

    return res.json({
      projectId,
      sources: rows.map((r) => ({
        sourceType: r.source_type,
        sourceName: r.source_name,
        chunkCount: r.chunk_count,
        lastIngestedAt: r.last_ingested_at ? new Date(r.last_ingested_at).toISOString() : null,
      })),
    });
  } catch (err) {
    next(err);
  }
}

async function getProjectKnowledgeContext(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const projectId = req.params.id;
    const query = String(req.query.q || req.body?.q || '').trim();
    if (!query) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Query q is required' } });

    const k = Math.min(Math.max(Number(req.query.k || 6), 1), 12);
    const top = await retrieveTopKSql({ projectId, orgId, queryText: query, k });
    const contextText = top.map((r) => `[${r.source_type}] ${r.content}`).join('\n---\n');
    return res.json({
      projectId,
      bounded: true,
      query,
      knowledgeVersion: top[0]?.knowledge_version || 0,
      chunks: top.map((r) => ({
        sourceType: r.source_type,
        sourceName: r.source_name,
        score: r.score,
        content: r.content,
      })),
      contextText,
      policy: 'Use only returned context chunks for downstream bot responses.',
    });
  } catch (err) {
    next(err);
  }
}

async function reindexProjectKnowledge(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const projectId = req.params.id;
    const projectRes = await db.query(`SELECT id FROM projects WHERE id = $1 AND org_id = $2 LIMIT 1`, [projectId, orgId]);
    if (!projectRes.rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
    const result = await reindexProjectEmbeddings(projectId, orgId);
    return res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  archiveProject,
  deleteProject,
  ingestProjectKnowledge,
  listProjectBrainDrive,
  getProjectKnowledgeContext,
  reindexProjectKnowledge,
};
