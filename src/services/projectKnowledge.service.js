const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { fetchWebsiteData } = require('./websiteScraper.service');
const logger = require('../config/logger');
const db = require('../config/db');

const EMBED_MODEL = 'text-embedding-004';
const EMBED_DIM = 768;
const EMBED_BATCH_LIMIT = 96;

let _embedClient = null;
function getEmbedModel() {
  if (_embedClient) return _embedClient;
  const apiKey = String(
    process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
  ).trim();
  if (!apiKey) return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  _embedClient = genAI.getGenerativeModel({ model: EMBED_MODEL });
  return _embedClient;
}

async function embedTexts(texts) {
  const model = getEmbedModel();
  if (!model) {
    logger.warn('[knowledge] Gemini embedding model unavailable — falling back to hash embeddings');
    return texts.map((t) => hashEmbedFallback(t));
  }

  const results = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_LIMIT) {
    const batch = texts.slice(i, i + EMBED_BATCH_LIMIT);
    try {
      const resp = await model.batchEmbedContents({
        requests: batch.map((text) => ({
          content: { parts: [{ text: String(text || '').slice(0, 2048) }] },
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
      });
      for (const emb of resp.embeddings) {
        results.push(emb.values);
      }
    } catch (err) {
      logger.error('[knowledge] Gemini embedding batch failed, using hash fallback', {
        error: err.message,
        batchSize: batch.length,
      });
      for (const t of batch) {
        results.push(hashEmbedFallback(t));
      }
    }
  }
  return results;
}

async function embedSingleText(text, taskType = 'RETRIEVAL_QUERY') {
  const model = getEmbedModel();
  if (!model) return hashEmbedFallback(text);
  try {
    const resp = await model.embedContent({
      content: { parts: [{ text: String(text || '').slice(0, 2048) }] },
      taskType,
    });
    return resp.embedding.values;
  } catch (err) {
    logger.error('[knowledge] Gemini single embed failed', { error: err.message });
    return hashEmbedFallback(text);
  }
}

function hashEmbedFallback(text) {
  const dim = EMBED_DIM;
  const vec = new Array(dim).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i += 1) h = ((h * 31) + t.charCodeAt(i)) >>> 0;
    vec[h % dim] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, n) => s + (n * n), 0)) || 1;
  return vec.map((n) => Number((n / mag).toFixed(6)));
}

function splitIntoChunks(text, max = 700) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const out = [];
  let start = 0;
  while (start < raw.length) {
    let end = Math.min(raw.length, start + max);
    if (end < raw.length) {
      const lastSpace = raw.lastIndexOf(' ', end);
      if (lastSpace > start + max * 0.5) end = lastSpace;
    }
    out.push(raw.slice(start, end).trim());
    start = end;
  }
  return out.filter(Boolean);
}

// ─── Extractors (unchanged) ───────────────────────────────────────────────

async function extractWebsiteKnowledge(url) {
  const meta = await fetchWebsiteData(url);
  const packed = [
    meta.title ? `Title: ${meta.title}` : '',
    meta.description ? `Description: ${meta.description}` : '',
    meta.keywords?.length ? `Keywords: ${meta.keywords.join(', ')}` : '',
    meta.phones?.length ? `Phones: ${meta.phones.join(', ')}` : '',
    meta.emails?.length ? `Emails: ${meta.emails.join(', ')}` : '',
    Object.keys(meta.socialLinks || {}).length ? `Social: ${JSON.stringify(meta.socialLinks)}` : '',
  ].filter(Boolean).join('\n');
  return {
    sourceType: 'website',
    sourceName: url,
    content: packed || `Website analyzed: ${url}`,
    metadata: { url, scrapedAt: new Date().toISOString() },
  };
}

async function extractPdfKnowledge(file) {
  const parsed = await pdfParse(file.buffer);
  return {
    sourceType: 'pdf',
    sourceName: file.originalname || 'uploaded.pdf',
    content: String(parsed.text || '').slice(0, 50000),
    metadata: { pages: parsed.numpages || null },
  };
}

function extractBusinessKnowledge(text) {
  return {
    sourceType: 'business_description',
    sourceName: 'business_description',
    content: String(text || '').trim(),
    metadata: {},
  };
}

function extractPlainTextKnowledge(title, text) {
  const body = String(text || '').trim();
  const name = String(title || '').trim() || 'Brain Drive text';
  return {
    sourceType: 'plain_text',
    sourceName: name.slice(0, 220),
    content: body,
    metadata: { kind: 'plain_text' },
  };
}

function extractDriveLinkKnowledge(url, notes) {
  const u = String(url || '').trim();
  const n = String(notes || '').trim();
  const content = [
    u ? `Drive / cloud file link: ${u}` : '',
    n ? `Internal notes for replies: ${n}` : '',
    'Use organization-approved material behind this link when answering customers.',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    sourceType: 'drive_link',
    sourceName: (u || 'drive_link').slice(0, 220),
    content: content || 'Drive link',
    metadata: { url: u || null, hasNotes: Boolean(n) },
  };
}

async function extractWebpageKnowledge(url) {
  const meta = await fetchWebsiteData(url);
  const packed = [
    meta.title ? `Title: ${meta.title}` : '',
    meta.description ? `Description: ${meta.description}` : '',
    meta.keywords?.length ? `Keywords: ${meta.keywords.join(', ')}` : '',
    meta.phones?.length ? `Phones: ${meta.phones.join(', ')}` : '',
    meta.emails?.length ? `Emails: ${meta.emails.join(', ')}` : '',
    Object.keys(meta.socialLinks || {}).length ? `Social: ${JSON.stringify(meta.socialLinks)}` : '',
  ].filter(Boolean).join('\n');
  return {
    sourceType: 'webpage',
    sourceName: url,
    content: packed || `Web page analyzed: ${url}`,
    metadata: { url, scrapedAt: new Date().toISOString() },
  };
}

function extractLogoKnowledge(file) {
  return {
    sourceType: 'logo',
    sourceName: file.originalname || 'logo',
    content: `Logo asset uploaded: ${file.originalname || 'logo'}`,
    metadata: { mime: file.mimetype || null, size: file.size || null },
  };
}

// ─── Build & Embed (now async) ────────────────────────────────────────────

async function buildKnowledgeRows(extracted) {
  const chunks = splitIntoChunks(extracted.content, 800);
  if (!chunks.length) return [];
  const embeddings = await embedTexts(chunks);
  return chunks.map((chunk, i) => ({
    ...extracted,
    content: chunk,
    embedding: embeddings[i] || hashEmbedFallback(chunk),
  }));
}

// ─── Retrieval ────────────────────────────────────────────────────────────

function vecToSql(vec) {
  return `[${vec.join(',')}]`;
}

async function retrieveTopKSql({ projectId, orgId, queryText, k = 8 }) {
  // Strategy 1: pgvector similarity (requires working embeddings + extension)
  try {
    const qVec = await embedSingleText(queryText, 'RETRIEVAL_QUERY');
    const isRealEmbedding = qVec.filter(v => v !== 0).length > 20;
    if (isRealEmbedding) {
      const vecStr = vecToSql(qVec);
      const { rows } = await db.query(
        `SELECT source_type, source_name, content, metadata, knowledge_version, created_at,
                1 - (embedding_vec <=> $3::vector) AS score
         FROM project_knowledge
         WHERE project_id = $1 AND org_id = $2
           AND embedding_vec IS NOT NULL
         ORDER BY embedding_vec <=> $3::vector
         LIMIT $4`,
        [projectId, orgId, vecStr, k]
      );
      if (rows.length) return rows;
    }
  } catch (err) {
    logger.debug('[knowledge] pgvector search failed', { error: err.message });
  }

  // Strategy 2: PostgreSQL full-text search (no external API needed)
  try {
    const terms = String(queryText || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u0D7F\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
    if (terms.length) {
      const tsQuery = terms.map(t => `${t}:*`).join(' | ');
      const { rows } = await db.query(
        `SELECT source_type, source_name, content, metadata, knowledge_version, created_at,
                ts_rank(to_tsvector('simple', content), to_tsquery('simple', $3)) AS score
         FROM project_knowledge
         WHERE project_id = $1 AND org_id = $2
           AND to_tsvector('simple', content) @@ to_tsquery('simple', $3)
         ORDER BY score DESC
         LIMIT $4`,
        [projectId, orgId, tsQuery, k]
      );
      if (rows.length) {
        logger.debug('[knowledge] Full-text search returned results', { count: rows.length });
        return rows;
      }
    }
  } catch (err) {
    logger.debug('[knowledge] Full-text search failed', { error: err.message });
  }

  // Strategy 3: return all project knowledge rows (small dataset fallback)
  try {
    const { rows } = await db.query(
      `SELECT source_type, source_name, content, metadata, knowledge_version, created_at, 1.0 AS score
       FROM project_knowledge
       WHERE project_id = $1 AND org_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [projectId, orgId, k]
    );
    if (rows.length) {
      logger.debug('[knowledge] Returning all project knowledge rows', { count: rows.length });
    }
    return rows;
  } catch (err) {
    logger.debug('[knowledge] Direct query failed', { error: err.message });
    return [];
  }
}

async function retrieveTopKInMemory(qVec, projectId, orgId, k = 8) {
  const { rows } = await db.query(
    `SELECT source_type, source_name, content, embedding, metadata, knowledge_version, created_at
     FROM project_knowledge
     WHERE project_id = $1 AND org_id = $2`,
    [projectId, orgId]
  );
  if (!rows.length) return [];

  return rows
    .map((r) => {
      const emb = Array.isArray(r.embedding) ? r.embedding : [];
      return { ...r, score: cosine(qVec, emb) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < len; i++) {
    dot += (a[i] || 0) * (b[i] || 0);
    magA += (a[i] || 0) ** 2;
    magB += (b[i] || 0) ** 2;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

function retrieveTopK(query, rows, k = 6) {
  const q = hashEmbedFallback(query);
  return (rows || [])
    .map((r) => ({ ...r, score: cosine(q, Array.isArray(r.embedding) ? r.embedding : []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ─── Re-index ─────────────────────────────────────────────────────────────

async function reindexProjectEmbeddings(projectId, orgId) {
  const { rows } = await db.query(
    `SELECT id, content FROM project_knowledge WHERE project_id = $1 AND org_id = $2 ORDER BY created_at`,
    [projectId, orgId]
  );
  if (!rows.length) return { reindexed: 0 };

  const texts = rows.map((r) => r.content);
  const embeddings = await embedTexts(texts);

  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    const vec = embeddings[i];
    if (!vec) continue;
    const jsonArr = JSON.stringify(vec);
    const vecStr = vecToSql(vec);
    try {
      await db.query(
        `UPDATE project_knowledge SET embedding = $2::jsonb, embedding_vec = $3::vector WHERE id = $1`,
        [rows[i].id, jsonArr, vecStr]
      );
      updated++;
    } catch (err) {
      await db.query(
        `UPDATE project_knowledge SET embedding = $2::jsonb WHERE id = $1`,
        [rows[i].id, jsonArr]
      );
      updated++;
    }
  }

  logger.info('[knowledge] Re-indexed project embeddings', { projectId, orgId, total: rows.length, updated });
  return { reindexed: updated, total: rows.length };
}

module.exports = {
  EMBED_DIM,
  extractWebsiteKnowledge,
  extractPdfKnowledge,
  extractBusinessKnowledge,
  extractLogoKnowledge,
  extractPlainTextKnowledge,
  extractDriveLinkKnowledge,
  extractWebpageKnowledge,
  buildKnowledgeRows,
  retrieveTopK,
  retrieveTopKSql,
  embedSingleText,
  embedTexts,
  reindexProjectEmbeddings,
  vecToSql,
};
