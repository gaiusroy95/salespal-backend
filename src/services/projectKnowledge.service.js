const pdfParse = require('pdf-parse');
const { fetchWebsiteData } = require('./websiteScraper.service');

const EMBED_DIM = 64;

function splitIntoChunks(text, max = 700) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const out = [];
  let start = 0;
  while (start < raw.length) {
    const end = Math.min(raw.length, start + max);
    out.push(raw.slice(start, end));
    start = end;
  }
  return out;
}

function embedText(text) {
  const vec = new Array(EMBED_DIM).fill(0);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const t of tokens) {
    let h = 0;
    for (let i = 0; i < t.length; i += 1) h = ((h * 31) + t.charCodeAt(i)) >>> 0;
    vec[h % EMBED_DIM] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, n) => s + (n * n), 0)) || 1;
  return vec.map((n) => Number((n / mag).toFixed(6)));
}

function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i += 1) sum += Number(a[i] || 0) * Number(b[i] || 0);
  return sum;
}

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

/** Long-form text pasted into Brain Drive (Sales / Post-Sales / Support). */
function extractPlainTextKnowledge(title, text) {
  const body = String(text || '').trim();
  const name = String(title || '').trim() || 'Brain Drive — text';
  return {
    sourceType: 'plain_text',
    sourceName: name.slice(0, 220),
    content: body,
    metadata: { kind: 'plain_text' },
  };
}

/**
 * Google Drive (or similar) link + optional team notes.
 * Public file content is not fetched automatically (auth); link + notes are indexed for RAG.
 */
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

function buildKnowledgeRows(extracted) {
  const chunks = splitIntoChunks(extracted.content, 800);
  return chunks.map((chunk) => ({
    ...extracted,
    content: chunk,
    embedding: embedText(chunk),
  }));
}

function retrieveTopK(query, rows, k = 6) {
  const q = embedText(query);
  return (rows || [])
    .map((r) => ({ ...r, score: cosine(q, Array.isArray(r.embedding) ? r.embedding : []) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

module.exports = {
  extractWebsiteKnowledge,
  extractPdfKnowledge,
  extractBusinessKnowledge,
  extractLogoKnowledge,
  extractPlainTextKnowledge,
  extractDriveLinkKnowledge,
  extractWebpageKnowledge,
  buildKnowledgeRows,
  retrieveTopK,
};
