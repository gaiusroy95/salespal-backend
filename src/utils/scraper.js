const axios = require('axios');
const cheerio = require('cheerio');

function ensureAbsoluteUrl(url, baseUrl) {
  if (!url) return null;
  // Handle protocol-relative URLs
  if (url.startsWith('//')) {
      url = 'https:' + url;
  }
  try {
    return new URL(url, baseUrl).href;
  } catch (e) {
    return null;
  }
}

const { chromium } = require('playwright');

async function scrapePlaywright(websiteUrl) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Fast fail 10s timeout, wait for full load. Catch timeout to gracefully scrape whatever is rendered.
    await page.goto(websiteUrl, { waitUntil: 'networkidle', timeout: 10000 }).catch(err => {
        console.log(`[Scraper] Playwright networkidle timeout reached. Proceeding with partially rendered DOM.`);
    });
    
    const title = await page.title().catch(() => '');
    const metaDesc = await page.$eval('meta[name="description"]', el => el.content).catch(() => '');
    
    // Extract actual visible layout text
    const innerText = await page.evaluate(() => document.body.innerText).catch(() => '');
    
    // Extract large visible images logic
    const rawImages = await page.evaluate(() => {
       return Array.from(document.querySelectorAll('img'))
         .filter(img => {
            const src = img.src || img.getAttribute('data-src') || '';
            if (!src || src.includes('data:image/svg+xml') || src.includes('.svg')) return false;
            // Native DOM API helps easily filter structural images
            if (img.width < 300 && img.naturalWidth < 300) return false;
            return true;
         })
         .map(img => img.src || img.getAttribute('data-src'));
    }).catch(() => []);
    
    // Extract interactive products logic
    const products = await page.evaluate(() => {
       const prods = [];
       document.querySelectorAll('a, div, article, li').forEach(el => {
         const classText = (el.className || '').toString().toLowerCase();
         if (classText.includes('product') || classText.includes('item') || classText.includes('card')) {
            const nameEl = el.querySelector('h2, h3, h4, .title, .name');
            const imgEl = el.querySelector('img');
            const descEl = el.querySelector('p, .price, .description');
            
            if (nameEl && nameEl.innerText.length > 2 && nameEl.innerText.length < 100) {
               prods.push({
                 name: nameEl.innerText.trim(),
                 image: imgEl ? (imgEl.src || imgEl.getAttribute('data-src')) : null,
                 description: descEl ? descEl.innerText.trim() : ''
               });
            }
         }
       });
       return prods;
    }).catch(() => []);

    const favicon = await page.$eval('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]', el => el.href).catch(() => null);
    const ogImage = await page.$eval('meta[property="og:image"]', el => el.content).catch(() => null);
    const logoImg = await page.$eval('img[src*="logo"], img[data-src*="logo"]', el => el.src || el.getAttribute('data-src')).catch(() => null);
    
    await browser.close();
    
    let textContent = [
       title ? `Title: ${title}` : '',
       metaDesc ? `Description: ${metaDesc}` : '',
       innerText.replace(/\s+/g, ' ')
    ].filter(Boolean).join('\n').substring(0, 10000);

    const images = Array.from(new Set(rawImages.map(url => ensureAbsoluteUrl(url, websiteUrl)).filter(Boolean))).slice(0, 8);
    
    const uniqueProducts = [];
    const prodSet = new Set();
    for (const p of products) {
      if (!prodSet.has(p.name.toLowerCase())) {
         prodSet.add(p.name.toLowerCase());
         p.image = ensureAbsoluteUrl(p.image, websiteUrl);
         uniqueProducts.push(p);
      }
    }

    // Same priority as Cheerio: og:image > img[src*=logo] > favicon > first image
    let logo = ensureAbsoluteUrl(ogImage, websiteUrl) || ensureAbsoluteUrl(logoImg, websiteUrl) || ensureAbsoluteUrl(favicon, websiteUrl);
    if (!logo && images.length > 0) logo = images[0];

    return {
       textContent,
       images,
       products: uniqueProducts.slice(0, 10),
       logo,
       links: [] // Not prioritized in fallback
    };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    throw error;
  }
}

async function scrapeCheerio(websiteUrl) {
  const result = {
    textContent: '',
    images: [],
    products: [],
    logo: null,
    links: []
  };

  try {
    const response = await axios.get(websiteUrl, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    const $ = cheerio.load(response.data);

    // 1. EXTRACT META & TITLE
    const title = $('title').text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') || '';
    const ogTitle = $('meta[property="og:title"]').attr('content') || '';
    const ogDesc = $('meta[property="og:description"]').attr('content') || '';
    
    let textParts = [];
    if (title) textParts.push(`Title: ${title}`);
    if (ogTitle && ogTitle !== title) textParts.push(`OG Title: ${ogTitle}`);
    if (metaDesc) textParts.push(`Description: ${metaDesc}`);
    if (ogDesc && ogDesc !== metaDesc) textParts.push(`OG Description: ${ogDesc}`);

    // Clean noise
    $('script, style, noscript, nav, footer, header, iframe, svg, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();

    // Headings
    $('h1, h2, h3').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length > 3) textParts.push(text);
    });

    // Paragraphs
    $('p, li, span.description, div.content').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text && text.length > 20 && text.split(' ').length > 3) {
        textParts.push(text);
      }
    });

    result.textContent = Array.from(new Set(textParts)).join('\n').substring(0, 10000);

    // 2. EXTRACT LOGO (strict priority order)
    const ogImage = ensureAbsoluteUrl($('meta[property="og:image"]').attr('content'), websiteUrl);
    
    // Try img tags whose src contains "logo"
    const logoImg = ensureAbsoluteUrl(
      $('img[src*="logo"], img[data-src*="logo"]').first().attr('src') ||
      $('img[src*="logo"], img[data-src*="logo"]').first().attr('data-src'),
      websiteUrl
    );
    
    // Try img tags whose alt or class contains "logo" (broader catch)
    let logoAltMatch = null;
    $('img').each((_, el) => {
      if (logoAltMatch) return;
      const alt = ($(el).attr('alt') || '').toLowerCase();
      const cls = ($(el).attr('class') || '').toLowerCase();
      if (alt.includes('logo') || cls.includes('logo')) {
        const src = $(el).attr('src') || $(el).attr('data-src');
        if (src) logoAltMatch = ensureAbsoluteUrl(src, websiteUrl);
      }
    });
    
    const favicon = ensureAbsoluteUrl(
      $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').first().attr('href'),
      websiteUrl
    );

    // Priority: og:image > img[src*=logo] > img[alt/class=logo] > favicon
    result.logo = ogImage || logoImg || logoAltMatch || favicon || null;

    // 3. EXTRACT IMAGES (separate from logo)
    const imageCandidates = new Set();
    let firstImage = null;

    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (!src) return;
      if (src.includes('data:image/svg+xml') || src.endsWith('.svg')) return;
      
      const absoluteSrc = ensureAbsoluteUrl(src, websiteUrl);
      if (!absoluteSrc) return;

      if (!firstImage) firstImage = absoluteSrc;
      imageCandidates.add(absoluteSrc);
    });

    // If no logo was found at all, use first meaningful image
    if (!result.logo && firstImage) result.logo = firstImage;

    result.images = Array.from(imageCandidates).slice(0, 8);

    // 4. DETECT PRODUCTS
    $('a, div, li, article').each((_, el) => {
      const classText = ($(el).attr('class') || '').toLowerCase();
      if (classText.includes('product') || classText.includes('item') || classText.includes('card')) {
        const prodName = $(el).find('h2, h3, h4, .title, .name').first().text().trim();
        const prodImgSrc = $(el).find('img').first().attr('src') || $(el).find('img').first().attr('data-src');
        const prodImg = ensureAbsoluteUrl(prodImgSrc, websiteUrl);
        const prodDesc = $(el).find('p, .price, .description').first().text().trim() || '';

        if (prodName && prodName.length > 2 && prodName.length < 100) {
          result.products.push({
            name: prodName,
            image: prodImg || null,
            description: prodDesc
          });
        }
      }
    });

    const uniqueProducts = [];
    const prodSet = new Set();
    for (const p of result.products) {
      if (!prodSet.has(p.name.toLowerCase())) {
        prodSet.add(p.name.toLowerCase());
        uniqueProducts.push(p);
      }
    }
    result.products = uniqueProducts.slice(0, 10);

    // 5. EXTRACT LINKS
    $('a').each((_, el) => {
        const href = ensureAbsoluteUrl($(el).attr('href'), websiteUrl);
        const text = $(el).text().trim();
        if (href && href.startsWith('http') && text && text.length > 2) {
            result.links.push({ text, href });
        }
    });
    
    const uniqueLinks = [];
    const linkSet = new Set();
    for (const l of result.links) {
        if (!linkSet.has(l.href)) {
            linkSet.add(l.href);
            uniqueLinks.push(l);
        }
    }
    result.links = uniqueLinks.slice(0, 15);

  } catch (error) {
    console.error('[Scraper] Cheerio Error:', error.message);
  }

  return result;
}

async function scrapeWebsite(websiteUrl) {
  if (!websiteUrl || !websiteUrl.startsWith('http')) {
    websiteUrl = 'https://' + websiteUrl;
  }

  console.log(`[Scraper] Initializing cheerio scrape for: ${websiteUrl}`);
  let result = await scrapeCheerio(websiteUrl);

  const isWeak = result.textContent.length < 1000 || result.images.length === 0 || result.products.length === 0;

  if (isWeak) {
    console.log(`[Scraper] Cheerio returned weak structural data (Text: ${result.textContent.length} chars). Falling back to Playwright headless rendering for React/Vue DOM execution...`);
    try {
      const pwResult = await scrapePlaywright(websiteUrl);
      
      // Inherit the strongest signals from Playwright instead if it found more items
      if (pwResult.textContent.length > result.textContent.length) {
         result.textContent = pwResult.textContent;
      }
      if (pwResult.images.length > result.images.length) {
         result.images = pwResult.images;
      }
      if (pwResult.products.length > result.products.length) {
         result.products = pwResult.products;
      }
      if (!result.logo && pwResult.logo) {
         result.logo = pwResult.logo;
      }
    } catch (e) {
      console.error('[Scraper] Playwright fallback failed:', e.message);
    }
  }

  // Final validation fallback
  if (result.textContent.trim().length < 50) {
     result.textContent = `Website URL: ${websiteUrl}\nFallback text generated because main content was entirely protected via firewalls.`;
  }

  return result;
}

module.exports = { scrapeWebsite };
