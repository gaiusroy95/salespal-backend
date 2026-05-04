const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../config/logger');

const TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL and extract useful metadata for the campaign wizard.
 * Returns: { title, description, ogImage, favicon, keywords, phones, emails, socialLinks }
 */
async function fetchWebsiteData(url) {
  let html;

  try {
    const response = await axios.get(url, {
      timeout: TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SalesPalBot/1.0; +https://salespal.app)',
        Accept: 'text/html,application/xhtml+xml',
      },
      // Don't throw on non-2xx so we can still parse partial content
      validateStatus: (status) => status < 500,
    });
    html = response.data;
  } catch (err) {
    logger.warn(`fetchWebsiteData failed for ${url}: ${err.message}`);
    const error = new Error(`Could not fetch URL: ${err.message}`);
    error.statusCode = 422;
    error.code = 'FETCH_FAILED';
    throw error;
  }

  if (typeof html !== 'string') {
    const error = new Error('URL did not return HTML content');
    error.statusCode = 422;
    error.code = 'NOT_HTML';
    throw error;
  }

  const $ = cheerio.load(html);

  // ─── Basic meta ────────────────────────────────────────────────────────────
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('title').text() ||
    null;

  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    null;

  const ogImage =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    null;

  // ─── Favicon ───────────────────────────────────────────────────────────────
  const faviconHref =
    $('link[rel="icon"]').attr('href') ||
    $('link[rel="shortcut icon"]').attr('href') ||
    '/favicon.ico';

  let favicon = faviconHref;
  if (faviconHref && !faviconHref.startsWith('http')) {
    try {
      const base = new URL(url);
      favicon = new URL(faviconHref, base.origin).href;
    } catch {
      favicon = faviconHref;
    }
  }

  // ─── Keywords ──────────────────────────────────────────────────────────────
  const keywordsRaw = $('meta[name="keywords"]').attr('content') || '';
  const keywords = keywordsRaw
    ? keywordsRaw.split(',').map((k) => k.trim()).filter(Boolean)
    : [];

  // ─── Contact info extraction ───────────────────────────────────────────────
  const bodyText = $('body').text();

  const phoneRe = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

  const phones = [...new Set((bodyText.match(phoneRe) || []).map((p) => p.trim()))].slice(0, 5);
  const emails = [...new Set((bodyText.match(emailRe) || []))].slice(0, 5);

  // ─── Social links ──────────────────────────────────────────────────────────
  const socialDomains = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'tiktok.com'];
  const socialLinks = {};

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    for (const domain of socialDomains) {
      if (href.includes(domain)) {
        const key = domain.split('.')[0];
        if (!socialLinks[key]) socialLinks[key] = href;
      }
    }
  });

  return {
    title: title?.trim() || null,
    description: description?.trim() || null,
    ogImage: ogImage || null,
    favicon,
    keywords,
    phones,
    emails,
    socialLinks,
  };
}

module.exports = { fetchWebsiteData };
