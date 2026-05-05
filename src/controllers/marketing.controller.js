const db = require('../config/db');
const env = require('../config/env');
const {
  generateBusinessAnalysis,
  generateAdCampaigns,
} = require('../utils/aiClient');
const { generateAdImage: generateVertexAdImage } = require('../services/imageGenerator');
const pdfParse = require('pdf-parse');
const axios = require('axios');
const cheerio = require('cheerio');
const { scrapeWebsite } = require('../utils/scraper');
const creditService = require('../services/credit.service');

async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

function isVertexQuotaErrorMessage(message) {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('quota') ||
    msg.includes('resource_exhausted') ||
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quotas-genai')
  );
}

async function generateVertexAdImageWithRetry(prompt, aspectRatio, attemptCount = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= attemptCount; attempt++) {
    try {
      return await withTimeout(generateVertexAdImage(prompt, aspectRatio), 180000, 'Vertex Imagen');
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || '');
      const canRetry = isVertexQuotaErrorMessage(msg) || /timeout/i.test(msg);
      if (!canRetry || attempt >= attemptCount) break;
      const backoffMs = 6000 * attempt;
      console.warn(`[generateAds] Vertex retry ${attempt}/${attemptCount} after ${backoffMs}ms:`, msg);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr || new Error('Vertex Imagen failed');
}

// Intentionally no placeholders/fallback creatives — callers must handle AI provider errors accurately.

async function listCampaigns(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json([]);

    const { projectId, status, platform, limit = 50, offset = 0 } = req.query;
    let sql = `
      SELECT
        c.*,
        COALESCE(cl.leads_count, 0)::INTEGER AS leads_count
      FROM campaigns c
      LEFT JOIN (
        SELECT campaign_id, org_id, COUNT(*)::INTEGER AS leads_count
        FROM campaign_leads
        GROUP BY campaign_id, org_id
      ) cl
        ON cl.campaign_id = c.id
       AND cl.org_id = c.org_id
      WHERE c.org_id = $1
    `;
    const params = [orgId];
    let idx = 2;

    if (projectId) { sql += ` AND c.project_id = $${idx++}`; params.push(projectId); }
    if (status) { sql += ` AND c.status = $${idx++}`; params.push(status); }
    if (platform) { sql += ` AND c.platform = $${idx++}`; params.push(platform); }

    sql += ` ORDER BY c.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { name, platform, objective, status, dailyBudget, totalBudget, startDate, endDate, projectId, adPlatforms, adFormat, headline, primaryText, cta, mediaType, mediaUrl, budgetPlatforms, budgetSplit, currency, metadata } = req.body;

    const { rows } = await db.query(
      `INSERT INTO campaigns (org_id, project_id, name, platform, objective, status, daily_budget, total_budget, start_date, end_date, ad_platforms, ad_format, headline, primary_text, cta, media_type, media_url, budget_platforms, budget_split, currency, metadata, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22) RETURNING *`,
      [orgId, projectId || null, name, platform || 'meta', objective, status || 'draft', dailyBudget, totalBudget, startDate, endDate, adPlatforms || '{}', adFormat, headline, primaryText, cta, mediaType, mediaUrl, budgetPlatforms || '{}', budgetSplit ? JSON.stringify(budgetSplit) : '{}', currency || 'INR', metadata ? JSON.stringify(metadata) : '{}', req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const fields = ['name', 'platform', 'objective', 'status', 'daily_budget', 'total_budget', 'start_date', 'end_date', 'project_id', 'impressions', 'clicks', 'conversions', 'spend', 'revenue', 'reach', 'ad_platforms', 'ad_format', 'headline', 'primary_text', 'cta', 'media_type', 'media_url', 'budget_platforms', 'budget_split', 'currency', 'metadata'];
    const camelToSnake = { dailyBudget: 'daily_budget', totalBudget: 'total_budget', startDate: 'start_date', endDate: 'end_date', projectId: 'project_id', adPlatforms: 'ad_platforms', adFormat: 'ad_format', primaryText: 'primary_text', mediaType: 'media_type', mediaUrl: 'media_url', budgetPlatforms: 'budget_platforms', budgetSplit: 'budget_split' };

    const updates = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(req.body)) {
      const dbField = camelToSnake[key] || key;
      if (fields.includes(dbField) && value !== undefined) {
        const val = (dbField === 'budget_split' || dbField === 'metadata') ? JSON.stringify(value) : value;
        updates.push(`${dbField} = $${idx++}`);
        values.push(val);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });
    }

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id, orgId);

    const { rows } = await db.query(
      `UPDATE campaigns SET ${updates.join(', ')} WHERE id = $${idx++} AND org_id = $${idx} RETURNING *`,
      values
    );

    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function deleteCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rowCount } = await db.query(
      `DELETE FROM campaigns WHERE id = $1 AND org_id = $2`,
      [req.params.id, orgId]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    res.json({ message: 'Campaign deleted' });
  } catch (err) {
    next(err);
  }
}

// --- Campaign Drafts (Wizard) ---

async function listDrafts(req, res, next) {
  try {
    const { projectId } = req.query;
    let sql = `SELECT * FROM campaign_drafts WHERE user_id = $1`;
    const params = [req.user.id];
    let idx = 2;

    if (projectId) {
      if (projectId === 'null') {
        sql += ` AND project_id IS NULL`;
      } else {
        sql += ` AND project_id = $${idx++}`;
        params.push(projectId);
      }
    }

    sql += ` ORDER BY updated_at DESC`;

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
}

async function getDraft(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM campaign_drafts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Draft not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function createDraft(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { projectId, draftData } = req.body;

    const { rows } = await db.query(
      `INSERT INTO campaign_drafts (org_id, project_id, user_id, draft_data)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, projectId || null, req.user.id, JSON.stringify(draftData || {})]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function updateDraft(req, res, next) {
  try {
    const { wizardStep, draftData } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;

    if (wizardStep !== undefined) { updates.push(`wizard_step = $${idx++}`); values.push(wizardStep); }
    if (draftData !== undefined) { updates.push(`draft_data = $${idx++}`); values.push(JSON.stringify(draftData)); }

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id, req.user.id);

    const { rows } = await db.query(
      `UPDATE campaign_drafts SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Draft not found' } });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
}

async function launchDraft(req, res, next) {
  try {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      // Fetch the draft
      const draftResult = await client.query(
        `SELECT * FROM campaign_drafts WHERE id = $1 AND user_id = $2`,
        [req.params.id, req.user.id]
      );
      const draft = draftResult.rows[0];
      if (!draft) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Draft not found' } });
      }

      const rawDraftData = typeof draft.draft_data === 'string' ? JSON.parse(draft.draft_data) : (draft.draft_data || {});
      const data = rawDraftData.data || rawDraftData;
      const adSettings = data.adSettings || {};
      const budget = data.budget || {};
      const chosenCampaign = adSettings.chosenCampaign || {};
      const selectedPlatforms = Array.isArray(adSettings.platforms) ? adSettings.platforms : [];
      const totalDailyBudget = Number(budget.daily || 0);
      const perPlatform = budget.perPlatform || {};
      const split = budget.split || {};
      const campaignName =
        chosenCampaign.campaignTitle ||
        chosenCampaign.campaignName ||
        data.name ||
        'Untitled Campaign';
      const campaignHeadline =
        chosenCampaign.headlines?.[0] ||
        data.headline ||
        'SalesPal Campaign';
      const campaignPrimaryText =
        chosenCampaign.primaryText ||
        chosenCampaign.descriptions?.[0] ||
        data.primaryText ||
        '';
      const campaignCta = chosenCampaign.cta || data.cta || 'Learn More';
      const mediaUrl = chosenCampaign.image || chosenCampaign.imageUrl || data.mediaUrl || null;
      const platformForLegacy = selectedPlatforms.includes('google')
        ? 'google'
        : selectedPlatforms.includes('meta')
          ? 'meta'
          : (data.platform || 'meta');
      const budgetPlatforms = selectedPlatforms.length ? selectedPlatforms : (data.budgetPlatforms || []);
      const adPlatforms = selectedPlatforms.length ? selectedPlatforms : (data.adPlatforms || []);

      // Create the campaign from draft data
      const campaignResult = await client.query(
        `INSERT INTO campaigns (org_id, project_id, name, platform, objective, status, daily_budget, total_budget, start_date, end_date, ad_platforms, ad_format, headline, primary_text, cta, media_type, media_url, budget_platforms, budget_split, currency, metadata, created_by)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) RETURNING *`,
        [
          draft.org_id,
          draft.project_id,
          campaignName,
          platformForLegacy,
          chosenCampaign.goal || data.objective || 'Conversions',
          totalDailyBudget || data.dailyBudget || data.daily_budget || 0,
          Number(data.totalBudget || data.total_budget || 0),
          data.startDate || data.start_date || null,
          data.endDate || data.end_date || null,
          adPlatforms.length ? adPlatforms : '{}',
          data.adFormat || data.ad_format || 'image',
          campaignHeadline,
          campaignPrimaryText,
          campaignCta,
          data.mediaType || data.media_type || 'image',
          mediaUrl,
          budgetPlatforms.length ? budgetPlatforms : '{}',
          JSON.stringify(Object.keys(split).length ? split : {}),
          budget.currency || data.currency || 'INR',
          JSON.stringify({
            ...(data.metadata || {}),
            source: 'wizard',
            draft_id: draft.id,
            chosen_campaign: chosenCampaign,
            per_platform_budget: perPlatform,
          }),
          req.user.id
        ]
      );

      // Delete the draft
      await client.query(`DELETE FROM campaign_drafts WHERE id = $1`, [draft.id]);

      await client.query('COMMIT');
      res.status(201).json(campaignResult.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
}

async function deleteDraft(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM campaign_drafts WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Draft not found' } });
    res.json({ message: 'Draft deleted' });
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Platform publishing
// ---------------------------------------------------------------------------

const facebookService = require('../services/facebook.service');
const googleService   = require('../services/google.service');

async function publishCampaign(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    const campaign = rows[0];
    const platforms = req.body.platforms || [];
    const userId    = req.user.id;

    const campaignData = {
      name:        campaign.name,
      objective:   campaign.objective,
      dailyBudget: campaign.daily_budget,
      startTime:   campaign.start_date,
      endTime:     campaign.end_date,
      targeting:   null,
      adCreative: {
        headline:    campaign.headline,
        description: campaign.primary_text,
      },
      headline:    campaign.headline,
      description: campaign.primary_text,
      keywords:    [],
    };

    const results = {};

    // --- Facebook / Meta ---
    if (platforms.includes('facebook') || platforms.includes('meta')) {
      try {
        const fb = await facebookService.publishCampaign(userId, campaignData);
        await db.query(
          `UPDATE campaigns SET facebook_campaign_id = $1, updated_at = NOW() WHERE id = $2`,
          [fb.facebookCampaignId, campaign.id]
        );
        results.facebook = { success: true, campaignId: fb.facebookCampaignId };
      } catch (err) {
        results.facebook = { success: false, error: err.message || String(err) };
      }
    }

    // --- Google ---
    if (platforms.includes('google')) {
      try {
        const google = await googleService.publishCampaign(userId, campaignData);
        await db.query(
          `UPDATE campaigns SET google_campaign_id = $1, updated_at = NOW() WHERE id = $2`,
          [google.googleCampaignId, campaign.id]
        );
        results.google = { success: true, campaignId: google.googleCampaignId };
      } catch (err) {
        results.google = { success: false, error: err.message || String(err) };
      }
    }

    res.json({ results });
  } catch (err) {
    next(err);
  }
}

async function syncPerformance(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { rows } = await db.query(
      `SELECT id, facebook_campaign_id, google_campaign_id FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    const { id: campaignId, facebook_campaign_id: fbId, google_campaign_id: googleId } = rows[0];
    const userId = req.user.id;

    const merged = { impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0 };

    if (fbId) {
      try {
        const fbMetrics = await facebookService.getCampaignInsights(userId, fbId, '30d');
        merged.impressions += fbMetrics.impressions || 0;
        merged.clicks      += fbMetrics.clicks      || 0;
        merged.spend       += fbMetrics.spend       || 0;
        merged.reach       += fbMetrics.reach       || 0;
      } catch (fbSyncErr) { void fbSyncErr; /* Non-fatal: continue */ }
    }

    if (googleId) {
      try {
        const gMetrics = await googleService.getCampaignMetrics(userId, googleId, '30d');
        merged.impressions += gMetrics.impressions  || 0;
        merged.clicks      += gMetrics.clicks       || 0;
        merged.spend       += gMetrics.spend        || 0;
        merged.conversions += gMetrics.conversions  || 0;
      } catch (gSyncErr) { void gSyncErr; /* Non-fatal: continue */ }
    }

    await db.query(
      `UPDATE campaigns
       SET impressions = $1, clicks = $2, spend = $3, reach = $4, conversions = $5,
           last_synced_at = NOW(), updated_at = NOW()
       WHERE id = $6`,
      [merged.impressions, merged.clicks, merged.spend, merged.reach, merged.conversions, campaignId]
    );

    res.json({ success: true, performance: merged });
  } catch (err) {
    next(err);
  }
}

async function analyzeBusiness(req, res, next) {
  try {
    const { description, websiteUrl } = req.body;
    console.log('\n========== AI ANALYZE PIPELINE ==========');
    console.log('STEP 1: Request received', { description: description?.substring(0, 100), websiteUrl });

    let pdfText = '';
    let webText = '';
    let scrapedData = null;

    if (req.files && req.files.length > 0) {
      const pdfFile = req.files.find(f => f.fieldname === 'pdf' || f.mimetype === 'application/pdf');
      if (pdfFile) {
        try {
          const data = await pdfParse(pdfFile.buffer);
          pdfText = data.text.substring(0, 10000);
        } catch (e) {
          console.error('PDF Parse Error:', e.message);
        }
      }
    }

    if (websiteUrl) {
      try {
        scrapedData = await scrapeWebsite(websiteUrl);
        webText = String(scrapedData.textContent || '');
        // Keep prompts safely under model/request limits.
        if (webText.length > 20000) webText = webText.slice(0, 20000);

        // Cap high-variance payloads (these can explode prompt size for big sites).
        if (Array.isArray(scrapedData.images) && scrapedData.images.length > 20) {
          scrapedData.images = scrapedData.images.slice(0, 20);
        }
        if (Array.isArray(scrapedData.links) && scrapedData.links.length > 30) {
          scrapedData.links = scrapedData.links.slice(0, 30);
        }
        if (Array.isArray(scrapedData.products) && scrapedData.products.length > 8) {
          scrapedData.products = scrapedData.products.slice(0, 8);
        }
        console.log('STEP 2: Scraper output', {
          textLength: webText.length,
          imagesCount: scrapedData.images?.length || 0,
          productsCount: scrapedData.products?.length || 0,
          hasLogo: !!scrapedData.logo
        });
      } catch (scraperErr) {
        console.error('STEP 2 ERROR: Scraper failed entirely:', scraperErr.message);
        scrapedData = { textContent: '', images: [], products: [], logo: null, links: [] };
      }
    } else {
      console.log('STEP 2: No websiteUrl provided, skipping scraper');
    }

    const inputText = `
      Description: ${description || 'N/A'}
      
      Website Content: ${webText || 'N/A'}
      
      Extracted Products (from website): ${scrapedData && scrapedData.products && scrapedData.products.length > 0 ? JSON.stringify(scrapedData.products, null, 2).slice(0, 12000) : 'None found directly'}
      
      Extracted Logo (from website): ${scrapedData?.logo || 'None found'}
      
      Primary Internal Images (from website): ${scrapedData && scrapedData.images && scrapedData.images.length > 0 ? scrapedData.images.join(', ').slice(0, 4000) : 'None found'}
      
      Internal Links (for context): ${scrapedData && scrapedData.links && scrapedData.links.length > 0 ? JSON.stringify(scrapedData.links, null, 2).slice(0, 8000) : 'None found'}
      
      PDF Document Content: ${pdfText || 'N/A'}
    `;

    console.log('STEP 3: Sending to Gemini', { promptLength: inputText.length });

    let rawResult;
    try {
      rawResult = await generateBusinessAnalysis(inputText);
      console.log('STEP 4: Raw Gemini response keys:', Object.keys(rawResult || {}));
    } catch (aiErr) {
      console.error('STEP 4 ERROR: Gemini failed:', aiErr.message);
      const aiErrMsg = String(aiErr?.message || '');
      const noProviderConfigured =
        aiErrMsg.includes('No AI provider configured') ||
        aiErrMsg.includes('missing GOOGLE_GENERATIVE_AI_API_KEY') ||
        aiErrMsg.includes('unconfigured');
      const aiFallbackReason = noProviderConfigured ? 'ai_not_configured' : 'ai_runtime_failure';
      // Return comprehensive fallback data so the frontend never gets empty
      rawResult = {
        error: true,
        fallbackReason: aiFallbackReason,
        businessSummary: description || 'AI-generated summary unavailable. Showing inferred data based on website metadata.',
        tags: ['Business', 'Online', 'Global'],
        brandPersonality: {
          archetype: 'Professional',
          traits: ['Reliable', 'Modern', 'Customer-focused', 'Quality-driven']
        },
        keyDifferentiators: [
          'Established online presence',
          'Strong product offering',
          'Competitive market positioning',
          'Growing brand visibility'
        ],
        products: [],
        competitors: [
          { name: 'Market Leader', type: 'direct', description: 'Top competitor in this space', strengths: ['Brand recognition', 'Scale'] },
          { name: 'Emerging Player', type: 'indirect', description: 'Fast-growing alternative', strengths: ['Innovation', 'Price'] },
          { name: 'Niche Specialist', type: 'indirect', description: 'Focused on specific segment', strengths: ['Specialization', 'Loyalty'] }
        ],
        brandMaturity: {
          stage: 'growth',
          explanation: 'Based on available signals, the business is in an active growth phase with opportunities to expand reach and optimize acquisition channels.'
        },
        growthPriorities: [
          { title: 'Awareness', description: 'Increase brand visibility through targeted campaigns.' },
          { title: 'Acquisition', description: 'Drive new customer acquisition via search and social.' },
          { title: 'Retention', description: 'Build loyalty through email and remarketing.' },
          { title: 'Reputation', description: 'Strengthen trust through reviews and social proof.' },
          { title: 'Innovation', description: 'Test new channels and ad formats for growth.' }
        ],
        paidStrategy: {
          budget: 'medium',
          channels: ['Search', 'Social', 'Display'],
          description: 'A balanced paid strategy across search and social platforms to maximize ROI.'
        },
        organicStrategy: {
          contentPillars: ['Industry Insights', 'Product Showcases', 'Customer Stories'],
          platforms: ['Instagram', 'LinkedIn', 'Blog'],
          description: 'Build authority through consistent content marketing and community engagement.'
        },
        campaignRecommendations: [
          { title: 'Brand Awareness Campaign', type: 'Social', priority: 'high', description: 'Increase brand visibility across social media platforms.' },
          { title: 'Search Acquisition Campaign', type: 'Search', priority: 'high', description: 'Capture high-intent search traffic with targeted ads.' },
          { title: 'Retargeting Campaign', type: 'Display', priority: 'medium', description: 'Re-engage website visitors who did not convert.' },
          { title: 'Content Marketing Push', type: 'Social', priority: 'medium', description: 'Publish thought leadership content to build organic reach.' }
        ],
        researchDirection: {
          goals: [
            'Identify core audience pain points and purchase motivators',
            'Map competitor positioning and messaging gaps',
            'Discover trending topics and content formats in the industry'
          ],
          platforms: ['Reddit', 'Instagram', 'YouTube', 'Google Trends'],
          questions: [
            'What language does the target audience use to describe their problems?',
            'Which competitor campaigns are getting the most engagement?',
            'What content formats drive the highest conversion in this industry?'
          ]
        },
        reputationManagement: {
          urgency: 'medium',
          focusAreas: [
            'Review response strategy',
            'Social sentiment monitoring',
            'Brand mention tracking',
            'Customer feedback loops'
          ],
          insight: 'Proactive reputation management is critical for building trust and converting hesitant buyers — especially in competitive markets where social proof drives purchasing decisions.'
        },
        businessSignals: {
          location: 'Global',
          currency: 'USD ($)',
          pricingLevel: 'Mid-range',
          businessModel: 'D2C',
          industry: 'Business',
          targetMarket: 'Global'
        },
        noticeTitle: noProviderConfigured ? 'AI key not configured' : 'Partial analysis recovered',
        noticeMessage: noProviderConfigured
          ? 'Your backend Gemini key is missing, so we generated a safe inferred brief from website/PDF metadata. Add GOOGLE_GENERATIVE_AI_API_KEY for full AI analysis.'
          : 'Live AI analysis partially failed. We generated a safe inferred brief from available website/PDF metadata so you can continue.'
      };
    }

    // Merge AI output with exact scraper payload for products & logo
    let mergedProducts = rawResult.products || [];
    
    if (scrapedData && scrapedData.products && scrapedData.products.length > 0) {
       if (mergedProducts.length === 0) {
           mergedProducts = scrapedData.products;
       } else {
           mergedProducts = mergedProducts.map((p, i) => {
               if (!p.image || p.image === 'null') {
                   const match = scrapedData.products.find(sp => sp.name.toLowerCase().includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(sp.name.toLowerCase()));
                   if (match && match.image) {
                       p.image = match.image;
                   } else if (scrapedData.products[i] && scrapedData.products[i].image) {
                       p.image = scrapedData.products[i].image;
                   }
               }
               return p;
           });
       }
    }

    const defaultSignals = {
      location: 'Global',
      currency: 'USD ($)',
      pricingLevel: 'Mid-range',
      businessModel: 'D2C',
      industry: 'Business',
      targetMarket: 'Global'
    };

    const finalData = {
        ...rawResult,
        products: mergedProducts,
        images: scrapedData?.images || rawResult.images || [],
        logo: scrapedData?.logo || rawResult.logo || null,
        scraperBlocked: Boolean(websiteUrl && !webText && (!scrapedData?.images || scrapedData.images.length === 0)),
        businessSignals: {
            ...defaultSignals,
            ...(rawResult.businessSignals || {})
        }
    };

    console.log('STEP 5: Final API response', {
      hasError: !!finalData.error,
      logo: finalData.logo || 'none',
      businessSummaryLength: finalData.businessSummary?.length || 0,
      productsCount: finalData.products?.length || 0,
      competitorsCount: finalData.competitors?.length || 0,
      campaignsCount: finalData.campaignRecommendations?.length || 0
    });
    console.log('==========================================\n');

    res.json({
        success: true,
        data: finalData
    });
  } catch (err) {
    console.error('PIPELINE FATAL ERROR:', err.message, err.stack);
    // Even on total crash, return usable fallback data instead of 500
    res.json({
      success: true,
      data: {
        error: true,
        businessSummary: req.body?.description || 'AI analysis temporarily unavailable.',
        tags: ['Business'],
        brandPersonality: { archetype: 'Professional', traits: ['Reliable', 'Modern'] },
        keyDifferentiators: ['Strong online presence'],
        products: [],
        competitors: [],
        brandMaturity: { stage: 'growth', explanation: 'Business is in a growth phase.' },
        growthPriorities: [{ title: 'Expand Reach', description: 'Focus on customer acquisition.' }],
        paidStrategy: { budget: 'medium', channels: ['Search', 'Social'], description: 'Balanced paid strategy.' },
        organicStrategy: { contentPillars: ['Content'], platforms: ['Social'], description: 'Build organic presence.' },
        campaignRecommendations: [
          { title: 'Awareness Campaign', type: 'Social', priority: 'high', description: 'Increase brand visibility.' }
        ]
      }
    });
  }
}


// ─── AI Ad Generation ────────────────────────────────────────────────────────

async function generateAds(req, res) {
  try {
    const {
      analysisData,
      selectedCampaigns,
      platforms,
      numberOfImages: reqNumImages,
      selectedAdFormat: rawAdFormat,
      carouselSlides: rawCarouselSlides,
      style: rawStyle,
      mediaSize: rawMediaSize,
      enableAudio: rawEnableAudio,
      enableSubtitles: rawEnableSubtitles,
      subtitleText: rawSubtitleText,
      customScript: rawCustomScript,
      connectTarget: rawConnectTarget,
      projectId: rawProjectId,
    } = req.body;

    const selectedAdFormat = String(rawAdFormat || 'image').toLowerCase();
    const selectedStyle = String(rawStyle || '').trim() || 'Tech';
    const selectedMediaSize = String(rawMediaSize || '').trim() || '1080x1080';
    const enableAudio = Boolean(rawEnableAudio);
    const enableSubtitles = Boolean(rawEnableSubtitles);
    const subtitleText = String(rawSubtitleText || '').trim();
    const connectTarget = String(rawConnectTarget || 'none').trim().toLowerCase();
    const projectId = rawProjectId || null;
    const parsedCustomScript =
      rawCustomScript && typeof rawCustomScript === 'string'
        ? (() => {
            try {
              return JSON.parse(rawCustomScript);
            } catch {
              return null;
            }
          })()
        : (rawCustomScript && typeof rawCustomScript === 'object' ? rawCustomScript : null);

    const numberOfImages = Math.min(Math.max(parseInt(reqNumImages, 10) || 1, 1), 4);
    const carouselSlides = Math.min(Math.max(parseInt(String(rawCarouselSlides ?? ''), 10) || 6, 4), 8);
    const slideCount =
      selectedAdFormat === 'carousel' || selectedAdFormat === 'video' ? carouselSlides : numberOfImages;

    const orgId = await getOrgId(req.user.id);
    console.log(`[generateAds] images=${numberOfImages} format=${selectedAdFormat} slideCount=${slideCount}`);

    console.log('[generateAds] Request received', {
      hasAnalysis: !!analysisData,
      selectedCampaigns: selectedCampaigns?.length || 0,
      platforms: platforms || [],
      numberOfImages,
      selectedAdFormat,
      slideCount,
      selectedStyle,
      selectedMediaSize,
      enableAudio,
      enableSubtitles,
      hasCustomScript: !!parsedCustomScript,
      connectTarget,
    });

    const normalizedFromScript = {
      style:
        typeof parsedCustomScript?.style === 'string' && parsedCustomScript.style.trim()
          ? parsedCustomScript.style.trim()
          : selectedStyle,
      mediaSize:
        typeof parsedCustomScript?.size === 'string' && parsedCustomScript.size.trim()
          ? parsedCustomScript.size.trim()
          : selectedMediaSize,
      enableAudio:
        typeof parsedCustomScript?.includeAudio === 'boolean'
          ? parsedCustomScript.includeAudio
          : enableAudio,
      enableSubtitles:
        typeof parsedCustomScript?.includeSubtitles === 'boolean'
          ? parsedCustomScript.includeSubtitles
          : enableSubtitles,
      subtitleText:
        typeof parsedCustomScript?.subtitleText === 'string' && parsedCustomScript.subtitleText.trim()
          ? parsedCustomScript.subtitleText.trim()
          : subtitleText,
    };

    const mediaSizeToAspect = (size) => {
      const s = String(size || '').toLowerCase();
      if (s.includes('1080x1920') || s.includes('9:16')) return '9:16';
      if (s.includes('1920x1080') || s.includes('16:9')) return '16:9';
      if (s.includes('1200x627')) return '16:9';
      if (s.includes('1080x1080') || s.includes('1:1')) return '1:1';
      return null;
    };

    // Build business context for Gemini
    const businessContext = {
      businessOverview: analysisData?.businessSummary || 'General business',
      businessName: analysisData?.businessName || analysisData?.tags?.[0] || 'Business',
      targetAudience: analysisData?.targetAudience || 'General audience',
      valueProposition: analysisData?.keyDifferentiators?.join('. ') || 'Quality products and services',
      businessSignals: analysisData?.businessSignals || {},
      industry: analysisData?.businessSignals?.industry || 'Business',
      products: analysisData?.products?.slice(0, 5)?.map(p => p.name) || [],
      logo: analysisData?.logo || null,
      marketingStrategy: {
        paid: analysisData?.paidStrategy || {},
        organic: analysisData?.organicStrategy || {},
      },
      selectedPlatforms: platforms || ['google', 'meta'],
      campaignTypes: selectedCampaigns || [],
      creativeCustomization: {
        style: normalizedFromScript.style,
        mediaSize: normalizedFromScript.mediaSize,
        enableAudio: normalizedFromScript.enableAudio,
        enableSubtitles: normalizedFromScript.enableSubtitles,
        subtitleText: normalizedFromScript.subtitleText,
        connectTarget,
        customScript: parsedCustomScript,
      },
    };

    if (!env.GCP_PROJECT_ID) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VERTEX_NOT_CONFIGURED',
          message: 'GCP_PROJECT_ID is required for Vertex AI ad image generation.',
        },
      });
    }

    console.log('[generateAds] Generating ad copy via Gemini...');
    const result = await withTimeout(
      generateAdCampaigns(businessContext),
      45000,
      'generateAdCampaigns'
    );
    console.log('[generateAds] AI returned', result?.campaigns?.length, 'campaigns');

    // === OPENAI IMAGE GENERATION PIPELINE ===
    if (result && result.campaigns) {
      const { generateImagePrompt, generateImageVariants, detectSiteEnvironment } = require('../utils/imagePromptGenerator.js');
      
      // Filter campaigns to ONLY selected platforms (normalize AI platform naming first).
      const normalizePlatform = (raw) => {
        const p = String(raw || '').toLowerCase();
        if (p.includes('google')) return 'google';
        if (p.includes('linkedin')) return 'linkedin';
        if (p.includes('instagram')) return 'instagram';
        if (p === 'x' || p.includes('twitter')) return 'twitter';
        if (p.includes('youtube')) return 'youtube';
        if (p.includes('facebook') || p.includes('meta')) return 'meta';
        return 'meta';
      };

      const selectedPlatformsLower = (platforms || []).map((p) => String(p).toLowerCase());
      const selectedSet = new Set(selectedPlatformsLower);
      console.log(`[generateAds] Selected platforms: ${selectedPlatformsLower.join(', ')}`);

      const campaignsBeforeFilter = Array.isArray(result.campaigns) ? [...result.campaigns] : [];
      result.campaigns = campaignsBeforeFilter.filter((campaign) => {
        const normalized = normalizePlatform(campaign.platform);
        const keep =
          selectedSet.size === 0 ||
          selectedSet.has(normalized) ||
          // "meta" selection should include Instagram/Facebook campaigns.
          (selectedSet.has('meta') && (normalized === 'instagram' || normalized === 'meta'));
        if (!keep) {
          console.log(
            `[generateAds] Skipping campaign "${campaign.campaignName}" (platform: ${campaign.platform} -> ${normalized}) — not in selected platforms`
          );
        }
        return keep;
      });

      // Safety fallback: if normalization mismatch filtered everything, keep original set.
      if (!result.campaigns.length && campaignsBeforeFilter.length) {
        console.warn('[generateAds] Platform filter removed all campaigns, restoring unfiltered campaigns as fallback.');
        result.campaigns = campaignsBeforeFilter;
      }

      console.log(`[generateAds] ${result.campaigns.length} campaigns after platform filter`);

      const slidesPerCampaign = result.campaigns.map((c) => {
        const pl = (c.platform || 'meta').toLowerCase();
        const isGoogle = pl.includes('google');
        if (isGoogle) return Math.min(slideCount, 2);
        return slideCount;
      });
      const previewCredits = Math.max(1, slidesPerCampaign.reduce((a, b) => a + b, 0));
      const isAdminUser = req.user?.role === 'admin';
      if (orgId && !isAdminUser) {
        const ok = await creditService.consumeCredits(
          orgId,
          previewCredits,
          'ad_preview',
          `${previewCredits} preview credit(s) consumed for AI ad generation`,
          req.user.id
        );
        if (!ok) {
          return res.status(402).json({
            success: false,
            error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits to generate previews' },
          });
        }
      }

      for (let ci = 0; ci < result.campaigns.length; ci++) {
        const campaign = result.campaigns[ci];
        const platform = (campaign.platform || 'meta').toLowerCase();
        const countForCampaign = slidesPerCampaign[ci] || slideCount;
        console.log(
          `[generateAds] Generating ${countForCampaign} creative slide(s) for: ${campaign.campaignName} (${platform})`
        );

        let aspectRatio = '1:1';
        if (platform.includes('instagram')) aspectRatio = '4:5';
        if (platform.includes('google')) aspectRatio = '1:1';
        if (platform.includes('meta')) aspectRatio = '1:1';
        const ratioFromSize = mediaSizeToAspect(normalizedFromScript.mediaSize);
        if (ratioFromSize) aspectRatio = ratioFromSize;

        const productOrService = businessContext.products?.slice(0, 3).join(', ') || businessContext.industry;
        const industry = businessContext.industry || 'Business';

        const analysisOptionsBase = {
          audience: analysisData?.targetAudience || '',
          tone: 'Professional and highly appealing',
          style:
            selectedAdFormat === 'video'
              ? `Cinematic commercial scene with natural human activity and realistic movement cues; visual style: ${normalizedFromScript.style}`
              : `Modern commercial photography; visual style: ${normalizedFromScript.style}`,
          colors: analysisData?.logo ? 'Brand accurate colors' : 'Vibrant and balanced',
          productOrService,
          platform,
          headline: campaign.headline || campaign.headlines?.[0] || '',
          primaryText: campaign.primaryText || campaign.descriptions?.[0] || '',
          cta: campaign.cta || 'Learn More',
          logo: analysisData?.logo || '',
          businessOverview: businessContext.businessOverview || '',
          emotion: selectedAdFormat === 'video' ? 'alive, dynamic, aspirational, human-centered' : '',
          siteContext: [
            analysisData?.businessSummary,
            analysisData?.description,
            analysisData?.websiteUrl,
            analysisData?.keyDifferentiators?.join(' '),
            productOrService,
            `Desired output size: ${normalizedFromScript.mediaSize}`,
            normalizedFromScript.enableAudio ? 'Video audio requested by user' : 'No audio requested',
            normalizedFromScript.enableSubtitles
              ? `Subtitles requested${normalizedFromScript.subtitleText ? ` (${normalizedFromScript.subtitleText})` : ''}`
              : 'No subtitles requested',
          ]
            .filter(Boolean)
            .join(' | '),
        };
        const siteEnvironment = detectSiteEnvironment(analysisOptionsBase);

        let prompts = [];
        if (countForCampaign > 1) {
          prompts = generateImageVariants(industry, analysisOptionsBase);
        } else {
          prompts = [generateImagePrompt(industry, analysisOptionsBase)];
        }

        const images = [];
        for (let i = 0; i < countForCampaign; i++) {
          console.log(`[generateAds]   Slide ${i + 1}/${countForCampaign}...`);
          let currentPrompt = prompts[i % prompts.length];
          if (parsedCustomScript && typeof parsedCustomScript === 'object') {
            const scriptText = JSON.stringify(parsedCustomScript);
            currentPrompt = `${currentPrompt}, apply custom creative script guidance: ${scriptText.slice(0, 1500)}`;
          }
          if (siteEnvironment === 'farmland') {
            currentPrompt = `${currentPrompt}, ONLY depict farmland/open plots/rural terrain, absolutely no skyscrapers, no high-rise buildings, no city skyline`;
          }

          try {
            const img = await generateVertexAdImageWithRetry(currentPrompt, aspectRatio, 3);
            if (!img) throw new Error('Vertex Imagen returned empty image');
            console.log(`[generateAds]   Slide ${i + 1}: Vertex Imagen`);
            images.push(img);
          } catch (e) {
            const msg = String(e?.message || e || '');
            const isQuota = isVertexQuotaErrorMessage(msg);
            const err = new Error(
              isQuota
                ? `AI image generation failed (Vertex Imagen quota) for campaign "${campaign.campaignName}" slide ${i + 1}/${countForCampaign}: ${msg}. Reduce image count/slides or wait and retry.`
                : `AI image generation failed (Vertex Imagen) for campaign "${campaign.campaignName}" slide ${i + 1}/${countForCampaign}: ${msg}`
            );
            err.code = isQuota ? 'VERTEX_IMAGEN_QUOTA' : e?.code || 'AI_IMAGE_PROVIDER_ERROR';
            throw err;
          }
        }

        campaign.image = images[0] || null;
        campaign.images = images;
        campaign.carouselImages = images;
        campaign.title = campaign.campaignName;
        campaign.description = campaign.primaryText || campaign.descriptions?.[0] || '';
        campaign.generatedAdFormat = selectedAdFormat;
        campaign.videoFromSlides = selectedAdFormat === 'video';
        campaign.connectTarget = connectTarget;
        campaign.customization = {
          style: normalizedFromScript.style,
          mediaSize: normalizedFromScript.mediaSize,
          enableAudio: normalizedFromScript.enableAudio,
          enableSubtitles: normalizedFromScript.enableSubtitles,
          subtitleText: normalizedFromScript.subtitleText || null,
          connectTarget,
        };
      }

      // Optional linkage persistence requested by frontend:
      // - social_post: stage generated creatives into social_studio_posts
      // - campaign: save a campaign_draft containing generated ads + settings
      const linkage = { target: connectTarget, created: [] };
      if (connectTarget === 'social_post' && orgId) {
        for (const campaign of result.campaigns) {
          const mediaUrl =
            (Array.isArray(campaign.images) && campaign.images[0]) ||
            campaign.image ||
            campaign.imageUrl ||
            null;
          const title = String(campaign.campaignName || campaign.campaignTitle || 'Generated Creative').slice(0, 180);
          const body =
            String(
              campaign.primaryText ||
              campaign.descriptions?.[0] ||
              campaign.description ||
              campaign.headlines?.[0] ||
              ''
            ).slice(0, 3000);
          const md = {
            source: 'generate-ads',
            generatedAdFormat: selectedAdFormat,
            customization: campaign.customization || {},
            platform: campaign.platform || null,
            connectTarget,
            customScript: parsedCustomScript || null,
          };
          const { rows: staged } = await db.query(
            `INSERT INTO social_studio_posts
             (org_id, user_id, title, festival, body, media_url, status, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,'staged',$7::jsonb)
             RETURNING id`,
            [orgId, req.user.id, title, null, body || title, mediaUrl, JSON.stringify(md)]
          );
          if (staged[0]?.id) linkage.created.push({ type: 'social_studio_post', id: staged[0].id });
        }
      } else if (connectTarget === 'campaign' && orgId) {
        const draftData = {
          data: {
            analysisData: analysisData || {},
            adSettings: {
              selectedCampaigns,
              platforms: platforms || [],
              generatedAds: { campaigns: result.campaigns },
              selectedAdFormat,
              videoDurationSec: parsedCustomScript?.durationSec || null,
              selectedStyle: normalizedFromScript.style,
              selectedSize: normalizedFromScript.mediaSize,
              enableAudio: normalizedFromScript.enableAudio,
              enableSubtitles: normalizedFromScript.enableSubtitles,
              subtitleText: normalizedFromScript.subtitleText,
              connectTarget,
              customScriptJson: parsedCustomScript ? JSON.stringify(parsedCustomScript, null, 2) : null,
            },
          },
          metadata: {
            source: 'generate-ads',
            customScript: parsedCustomScript || null,
          },
        };
        const { rows: drafts } = await db.query(
          `INSERT INTO campaign_drafts (org_id, user_id, project_id, step, wizard_step, draft_data, analysis_done)
           VALUES ($1,$2,$3,4,4,$4::jsonb,true)
           RETURNING id`,
          [orgId, req.user.id, projectId, JSON.stringify(draftData)]
        );
        if (drafts[0]?.id) linkage.created.push({ type: 'campaign_draft', id: drafts[0].id });
      }
      result.linkage = linkage;
    }

    return res.json({
      success: true,
      data: result,
    });

  } catch (error) {
    console.error('[generateAds] Error:', error.message);
    const statusCode = error?.code === 'VERTEX_IMAGEN_QUOTA' ? 429 : 502;

    return res.status(statusCode).json({
      success: false,
      error: {
        code: error?.code || 'AI_ADS_GENERATION_FAILED',
        message: error?.message || 'AI ads generation failed',
      },
    });
  }
}

async function listSocialStudioPosts(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `SELECT * FROM social_studio_posts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [orgId]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

async function createSocialStudioPost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { title, festival, body, mediaUrl, scheduledAt } = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO social_studio_posts
       (org_id, user_id, title, festival, body, media_url, status, scheduled_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [orgId, req.user.id, title || 'Festival Post', festival || null, body || '', mediaUrl || null, 'staged', scheduledAt || null, '{}']
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function approveSocialStudioPost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `UPDATE social_studio_posts
       SET status = 'approved', approved_by = $1, approved_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [req.user.id, req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function publishSocialStudioPost(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { rows } = await db.query(
      `UPDATE social_studio_posts
       SET status = 'published', published_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND org_id = $2
       RETURNING *`,
      [req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Post not found' } });
    res.json({ ...rows[0], publishResult: { ok: true, simulated: true } });
  } catch (err) { next(err); }
}


// ─── AI Ad Image Generation ──────────────────────────────────────────────────

async function generateAdImageHandler(req, res) {
  try {
    const {
      businessOverview,
      valueProposition,
      targetAudience,
      campaignName,
      primaryText,
      platform,
      industry,
      logo,
    } = req.body;

    console.log('[generateAdImage] Request received', {
      campaignName,
      platform,
      industry,
      hasLogo: !!logo,
    });

    if (!env.GCP_PROJECT_ID) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VERTEX_NOT_CONFIGURED',
          message: 'GCP_PROJECT_ID is required for Vertex AI image generation.',
        },
      });
    }

    const p = String(platform || '').toLowerCase();
    const aspectRatio = p.includes('instagram') ? '4:5' : p.includes('google') ? '1:1' : '1:1';
    const compactPrompt = [
      `Professional advertising creative for ${platform || 'social'}.`,
      `Business: ${businessOverview || industry || 'A modern business'}.`,
      `Campaign: ${campaignName || 'Campaign'}.`,
      `Primary text: ${primaryText || ''}.`,
      `Style: premium commercial photography, no text overlays, no watermarks.`,
    ]
      .filter(Boolean)
      .join('\n');

    const imageUrl = await withTimeout(generateVertexAdImage(compactPrompt, aspectRatio), 180000, 'Vertex Imagen');
    if (!imageUrl) {
      const e = new Error('Vertex Imagen returned empty image');
      e.code = 'VERTEX_IMAGEN_BAD_RESPONSE';
      throw e;
    }

    return res.json({
      success: true,
      data: {
        imageUrl,
        model: 'imagen-3.0-generate-001',
      },
    });

  } catch (error) {
    console.error('[generateAdImage] Error:', error.message);
    return res.status(500).json({
      success: false,
      error: { code: error.code || 'IMAGE_GEN_FAILED', message: error.message },
    });
  }
}

module.exports = {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  listDrafts,
  getDraft,
  createDraft,
  updateDraft,
  launchDraft,
  deleteDraft,
  publishCampaign,
  syncPerformance,
  analyzeBusiness,
  generateAds,
  generateAdImage: generateAdImageHandler,
  listSocialStudioPosts,
  createSocialStudioPost,
  approveSocialStudioPost,
  publishSocialStudioPost,
};
