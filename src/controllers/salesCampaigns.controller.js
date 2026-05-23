const db = require('../config/db');
const leadUploadService = require('../services/leadUpload.service');
const aiService = require('../services/ai.service');
const creditService = require('../services/credit.service');
const { isPlatformAdmin } = require('../utils/adminBypass');

const CAMPAIGN_REPORT_CREDIT_COST = 5;
const CAMPAIGN_REPORT_REF = 'campaign_report';

async function countOrgCampaignReports(orgId) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM credit_transactions
     WHERE org_id = $1 AND reference_type = $2`,
    [orgId, CAMPAIGN_REPORT_REF]
  );
  return rows[0]?.n ?? 0;
}

async function recordCampaignReportUsage(orgId, userId, { free, campaignId }) {
  const balance = await creditService.getBalance(orgId);
  const description = free
    ? `Campaign analysis report (free) — campaign ${campaignId}`
    : `Campaign analysis report — campaign ${campaignId}`;
  await db.query(
    `INSERT INTO credit_transactions
       (org_id, user_id, amount, type, balance_after, reference_type, reference_id, description)
     VALUES ($1, $2, $3, 'debit', $4, $5, $6, $7)`,
    [
      orgId,
      userId,
      free ? 0 : CAMPAIGN_REPORT_CREDIT_COST,
      balance,
      CAMPAIGN_REPORT_REF,
      campaignId,
      description,
    ]
  );
}

async function getCampaignLeadStats(campaignId, orgId) {
  const { rows: totalRows } = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'converted')::int AS converted,
       COUNT(*) FILTER (WHERE status = 'interested')::int AS interested,
       COUNT(*) FILTER (WHERE status = 'new')::int AS new_leads,
       COUNT(*) FILTER (WHERE status = 'called')::int AS called,
       COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected,
       COUNT(*) FILTER (WHERE last_activity > NOW() - INTERVAL '7 days')::int AS active_7d
     FROM campaign_leads
     WHERE campaign_id = $1 AND org_id = $2`,
    [campaignId, orgId]
  );
  const { rows: bySource } = await db.query(
    `SELECT COALESCE(NULLIF(TRIM(source), ''), 'Unknown') AS source, COUNT(*)::int AS count
     FROM campaign_leads
     WHERE campaign_id = $1 AND org_id = $2
     GROUP BY 1
     ORDER BY count DESC`,
    [campaignId, orgId]
  );
  return { totals: totalRows[0] || {}, bySource };
}

async function getOrgId(userId) {
  const { rows } = await db.query(
    `SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0]?.org_id || null;
}

async function ensureCampaignInOrg(campaignId, orgId) {
  const { rows } = await db.query(
    `SELECT id FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
    [campaignId, orgId]
  );
  return Boolean(rows[0]);
}

async function insertImportedCampaignLeads({ leads, campaignId, orgId, userId }) {
  let inserted = 0;

  for (let i = 0; i < (leads || []).length; i += 1) {
    const raw = leads[i] || {};
    const name = String(raw.name || '').trim() || `Lead ${i + 1}`;
    const phone = raw.phone ? String(raw.phone).trim() : null;
    const email = raw.email ? String(raw.email).trim() : null;

    // Skip rows with no actionable contact details.
    if (!phone && !email) continue;

    await db.query(
      `INSERT INTO campaign_leads (campaign_id, org_id, user_id, name, phone, email, source, ai_score_label, status, last_activity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Warm', 'new', NOW())`,
      [campaignId, orgId, userId, name, phone, email, raw.source || 'File Upload']
    );
    inserted += 1;
  }

  return inserted;
}

exports.createSalesCampaign = async (req, res, next) => {
  try {
    const orgId = req.user.orgId || await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'User has no organization' } });

    const { name, source, websiteUrl, description } = req.body;
    const metadata = JSON.stringify({ source: source || 'Manual', websiteUrl: websiteUrl || null, description: description || null });

    const { rows } = await db.query(
      `INSERT INTO campaigns (name, platform, metadata, status, org_id, user_id, created_by)
       VALUES ($1, 'sales', $2, 'active', $3, $4, $4)
       RETURNING *`,
      [name || 'Untitled Sales Campaign', metadata, orgId, req.user.id]
    );

    res.status(201).json({ campaign: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.getCampaignAnalyzeStatus = async (req, res, next) => {
  try {
    const orgId = req.user.orgId || (await getOrgId(req.user.id));
    if (!orgId) {
      return res.json({
        freeReportAvailable: true,
        reportsUsed: 0,
        creditCost: CAMPAIGN_REPORT_CREDIT_COST,
      });
    }

    const reportsUsed = await countOrgCampaignReports(orgId);
    const isAdmin = isPlatformAdmin(req.user);

    res.json({
      freeReportAvailable: reportsUsed === 0 || isAdmin,
      reportsUsed,
      creditCost: CAMPAIGN_REPORT_CREDIT_COST,
      adminBypass: isAdmin,
    });
  } catch (err) {
    next(err);
  }
};

exports.analyzeCampaignReport = async (req, res, next) => {
  try {
    const orgId = req.user.orgId || (await getOrgId(req.user.id));
    if (!orgId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'User has no organization' },
      });
    }

    const campaignId = req.params.id;
    const canUse = await ensureCampaignInOrg(campaignId, orgId);
    if (!canUse) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    const { rows } = await db.query(
      `SELECT * FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [campaignId, orgId]
    );
    const campaign = rows[0];
    if (!campaign) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    const isAdmin = isPlatformAdmin(req.user);
    const reportsUsed = await countOrgCampaignReports(orgId);
    const isFree = reportsUsed === 0;

    if (!isAdmin && !isFree) {
      await creditService.ensureCreditsRow(orgId, req.user.id);
      const ok = await creditService.consumeCredits(
        orgId,
        CAMPAIGN_REPORT_CREDIT_COST,
        CAMPAIGN_REPORT_REF,
        `Campaign analysis report — ${campaign.name || campaignId}`,
        req.user.id
      );
      if (!ok) {
        return res.status(402).json({
          error: {
            code: 'INSUFFICIENT_CREDITS',
            message: `Not enough credits. Each report after your first free one costs ${CAMPAIGN_REPORT_CREDIT_COST} credits.`,
            creditCost: CAMPAIGN_REPORT_CREDIT_COST,
          },
        });
      }
    }

    const leadStats = await getCampaignLeadStats(campaignId, orgId);
    const prompt = aiService.buildSalesCampaignReportPrompt(campaign, leadStats);

    let report;
    let fallback = false;
    let fallbackReason = null;

    try {
      if (isAdmin) {
        const skip = new Error('admin_bypass');
        skip.code = 'ADMIN_SKIP_GEMINI';
        throw skip;
      }
      report = await aiService.callAI(prompt);
    } catch (aiErr) {
      fallback = true;
      fallbackReason =
        aiErr?.code === 'ADMIN_SKIP_GEMINI'
          ? 'admin_usage_bypass'
          : aiErr?.code || 'ai_unavailable';
      report = aiService.buildOfflineSalesCampaignReport(campaign, leadStats);
    }

    if (!isAdmin) {
      await recordCampaignReportUsage(orgId, req.user.id, {
        free: isFree,
        campaignId,
      });
    }

    const generatedAt = new Date().toISOString();
    await db.query(
      `UPDATE campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND org_id = $3`,
      [
        JSON.stringify({
          last_analysis_report: {
            generatedAt,
            fallback,
            report: report.slice(0, 12000),
          },
        }),
        campaignId,
        orgId,
      ]
    );

    res.json({
      campaignId,
      campaignName: campaign.name,
      report,
      generatedAt,
      fallback,
      fallbackReason,
      billing: {
        free: isFree && !isAdmin,
        creditsCharged: !isAdmin && !isFree ? CAMPAIGN_REPORT_CREDIT_COST : 0,
        reportsUsedAfter: isAdmin ? reportsUsed : reportsUsed + 1,
        nextReportCreditCost: CAMPAIGN_REPORT_CREDIT_COST,
      },
      stats: leadStats,
    });
  } catch (err) {
    next(err);
  }
};

exports.getCampaignLeads = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.json({ leads: [] });

    const { rows } = await db.query(
      `SELECT * FROM campaign_leads WHERE campaign_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
      [req.params.id, orgId]
    );
    res.json({ leads: rows });
  } catch (err) {
    next(err);
  }
};

exports.addCampaignLead = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { name, phone, email } = req.body;
    const { rows } = await db.query(
      `INSERT INTO campaign_leads (campaign_id, org_id, user_id, name, phone, email, source, ai_score_label, status, last_activity)
       VALUES ($1, $2, $3, $4, $5, $6, 'Manual', 'Warm', 'new', NOW())
       RETURNING *`,
      [req.params.id, orgId, req.user.id, name, phone, email || null]
    );
    res.status(201).json({ lead: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.saveCampaignWebsite = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { websiteUrl } = req.body;
    const { rows } = await db.query(
      `UPDATE campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING *`,
      [JSON.stringify({ websiteUrl }), req.params.id, orgId]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    res.json({ campaign: rows[0] });
  } catch (err) {
    next(err);
  }
};

exports.uploadCsvLeads = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No CSV file uploaded' } });
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const campaignId = req.body.campaignId || req.body.campaign_id;
    if (!campaignId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'campaignId is required' } });
    }

    const canUseCampaign = await ensureCampaignInOrg(campaignId, orgId);
    if (!canUseCampaign) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    const leads = leadUploadService.parseCsvLeads(req.file.buffer);
    const insertedCount = await insertImportedCampaignLeads({
      leads,
      campaignId,
      orgId,
      userId: req.user.id,
    });

    res.json({
      leads,
      parsedCount: leads.length,
      count: insertedCount,
      skipped: Math.max(leads.length - insertedCount, 0),
    });
  } catch (err) {
    next(err);
  }
};

exports.uploadPdfLeads = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No PDF file uploaded' } });
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const campaignId = req.body.campaignId || req.body.campaign_id;
    if (!campaignId) {
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'campaignId is required' } });
    }

    const canUseCampaign = await ensureCampaignInOrg(campaignId, orgId);
    if (!canUseCampaign) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
    }

    const parsed = await leadUploadService.parsePdfLeads(req.file.buffer);
    const leads = parsed.leads || [];
    const insertedCount = await insertImportedCampaignLeads({
      leads,
      campaignId,
      orgId,
      userId: req.user.id,
    });

    if (insertedCount === 0) {
      const issues = [...(parsed.issues || [])];
      if (leads.length > 0) {
        issues.push(
          `${leads.length} contact-like line(s) were found but none could be saved (each lead needs at least a phone number or email).`
        );
      }
      const missing = [];
      if (parsed.parseFailed) missing.push('A valid, readable PDF file');
      else if ((parsed.textLength || 0) < 30) missing.push('Searchable text in the PDF (not only scanned images)');
      else if (leads.length === 0) missing.push('Plain-text phone numbers or email addresses in the document');
      else missing.push('At least one row with a usable phone number or email address');

      return res.status(400).json({
        error: {
          code: 'PDF_NO_IMPORTABLE_LEADS',
          message: issues[0] || 'No leads could be imported from this PDF.',
          details: {
            issues,
            missing,
            textCharactersExtracted: parsed.textLength ?? 0,
            pageCount: parsed.numpages ?? 0,
            parsedRows: leads.length,
            inserted: 0,
          },
        },
      });
    }

    res.json({
      leads,
      parsedCount: leads.length,
      count: insertedCount,
      skipped: Math.max(leads.length - insertedCount, 0),
    });
  } catch (err) {
    next(err);
  }
};
const facebookService = require('../services/facebook.service');

exports.createFacebookLeadForm = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    const { formName, questions } = req.body;
    if (!formName) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'formName is required' } });

    // Fetch page_id from meta integration
    const { rows: intRows } = await db.query(
      `SELECT metadata FROM integrations WHERE user_id = $1 AND platform = 'meta' AND status = 'connected' LIMIT 1`,
      [req.user.id]
    );
    if (!intRows.length) {
      return res.status(400).json({ error: { code: 'NOT_CONNECTED', message: 'Facebook is not connected' } });
    }
    const pageId = intRows[0]?.metadata?.page_id;
    if (!pageId) {
      return res.status(400).json({ error: { code: 'MISSING_PAGE', message: 'No Facebook Page ID found in integration. Please reconnect.' } });
    }

    // Build default questions if none supplied
    const formQuestions = (questions && questions.length)
      ? questions
      : [
          { type: 'FULL_NAME',     label: 'Name'  },
          { type: 'EMAIL',         label: 'Email' },
          { type: 'PHONE_NUMBER',  label: 'Phone' },
        ];

    const { leadGenFormId } = await facebookService.createLeadGenForm(
      req.user.id,
      pageId,
      { name: formName, questions: formQuestions }
    );

    // Store lead form ID in campaign metadata
    const { rows } = await db.query(
      `UPDATE campaigns
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND org_id = $3
       RETURNING id`,
      [JSON.stringify({ facebook_lead_form_id: leadGenFormId }), req.params.id, orgId]
    );
    if (!rows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    res.json({ success: true, leadFormId: leadGenFormId });
  } catch (err) {
    next(err);
  }
};

exports.syncLeadsFromFacebook = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    // Fetch campaign and extract facebook_lead_form_id from metadata
    const { rows: campRows } = await db.query(
      `SELECT metadata FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!campRows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    const leadFormId = campRows[0]?.metadata?.facebook_lead_form_id;
    if (!leadFormId) {
      return res.status(400).json({ error: { code: 'NO_FORM', message: 'No Facebook lead form set up for this campaign' } });
    }

    // Fetch leads from Facebook
    const fbLeads = await facebookService.getLeadsFromForm(req.user.id, leadFormId);
    const total = fbLeads.length;
    let synced = 0;
    let skipped = 0;

    for (const lead of fbLeads) {
      // Deduplicate by facebook_lead_id
      const { rows: existing } = await db.query(
        `SELECT id FROM campaign_leads WHERE facebook_lead_id = $1 LIMIT 1`,
        [lead.id]
      );
      if (existing.length) { skipped++; continue; }

      // Extract field values from Facebook lead gen form format
      const fields = {};
      (lead.field_data || []).forEach((f) => { fields[f.name] = f.values?.[0] || ''; });
      const name  = fields.full_name  || fields.name  || lead.name  || '';
      const email = fields.email                        || lead.email || null;
      const phone = fields.phone_number || fields.phone || lead.phone || '';

      await db.query(
        `INSERT INTO campaign_leads
           (campaign_id, org_id, user_id, name, phone, email, source, facebook_lead_id, ai_score_label, status, last_activity)
         VALUES ($1, $2, $3, $4, $5, $6, 'Facebook Lead Form', $7, 'Warm', 'new', NOW())
         ON CONFLICT DO NOTHING`,
        [req.params.id, orgId, req.user.id, name, phone, email, lead.id]
      );
      synced++;
    }

    res.json({ synced, skipped, total });
  } catch (err) {
    // Surface re-auth errors to the client
    if (err?.code === 'REAUTH_REQUIRED' || err?.response?.data?.error?.code === 190) {
      return res.status(401).json({ error: { code: 'REAUTH_REQUIRED', message: 'Facebook token expired. Please reconnect.', requiresReauth: true } });
    }
    next(err);
  }
};
const googleService = require('../services/google.service');

exports.syncLeadsFromGoogle = async (req, res, next) => {
  try {
    const orgId = await getOrgId(req.user.id);
    if (!orgId) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No organization found' } });

    // Fetch google_campaign_id from campaigns table
    const { rows: campRows } = await db.query(
      `SELECT google_campaign_id FROM campaigns WHERE id = $1 AND org_id = $2 LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!campRows.length) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Campaign not found' } });

    const googleCampaignId = campRows[0]?.google_campaign_id;
    if (!googleCampaignId) {
      return res.status(400).json({ error: { code: 'NOT_PUBLISHED', message: 'This campaign has not been published to Google yet' } });
    }

    // Fetch lead form submissions from Google Ads
    const googleLeads = await googleService.getLeadFormSubmissions(req.user.id, googleCampaignId);
    let synced = 0;
    let skipped = 0;

    for (const lead of googleLeads) {
      // Deduplicate by google_lead_id
      const { rows: existing } = await db.query(
        `SELECT id FROM campaign_leads WHERE google_lead_id = $1 LIMIT 1`,
        [lead.id]
      );
      if (existing.length) { skipped++; continue; }

      const name  = lead.name  || lead.full_name  || '';
      const email = lead.email || null;
      const phone = lead.phone || lead.phone_number || '';

      await db.query(
        `INSERT INTO campaign_leads
           (campaign_id, org_id, user_id, name, phone, email, source, google_lead_id, ai_score_label, status, last_activity)
         VALUES ($1, $2, $3, $4, $5, $6, 'Google Lead Form', $7, 'Warm', 'new', NOW())
         ON CONFLICT DO NOTHING`,
        [req.params.id, orgId, req.user.id, name, phone, email, lead.id]
      );
      synced++;
    }

    res.json({ synced, skipped, total: googleLeads.length });
  } catch (err) {
    if (err?.code === 'REAUTH_REQUIRED') {
      return res.status(401).json({ error: { code: 'REAUTH_REQUIRED', message: 'Google token expired. Please reconnect.', requiresReauth: true } });
    }
    next(err);
  }
};
