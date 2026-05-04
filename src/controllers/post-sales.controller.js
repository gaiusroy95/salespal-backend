const db = require('../config/db');

// ─── Helpers ────────────────────────────────────────────────────────────────
async function getOrgId(userId) {
  const { rows } = await db.query(`SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1`, [userId]);
  return rows[0]?.org_id || null;
}

// ─── CUSTOMERS ───────────────────────────────────────────────────────────────

async function listCustomers(req, res, next) {
  try {
    const { status, search, limit = 50, offset = 0 } = req.query;
    let sql = `
      SELECT c.*, 
             GREATEST(c.amount_paid, COALESCE((SELECT SUM(amount) FROM ps_payments WHERE customer_id = c.id AND status = 'paid'), 0)) as amount_paid
      FROM ps_customers c
      WHERE c.user_id = $1
    `;
    const params = [req.user.id];
    let idx = 2;

    if (status) { sql += ` AND c.status = $${idx++}`; params.push(status); }
    if (search) {
      sql += ` AND (c.name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx})`;
      params.push(`%${search}%`); idx++;
    }

    sql += ` ORDER BY c.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function getCustomer(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT c.*, 
              GREATEST(c.amount_paid, COALESCE((SELECT SUM(amount) FROM ps_payments WHERE customer_id = c.id AND status = 'paid'), 0)) as amount_paid
       FROM ps_customers c 
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function createCustomer(req, res, next) {
  try {
    const { name, phone, email, company, totalDue, amountPaid, dueDate, currency, status, tags, notes, metadata } = req.body;
    const orgId = await getOrgId(req.user.id);

    const { rows } = await db.query(
      `INSERT INTO ps_customers
        (user_id, org_id, name, phone, email, company, total_due, amount_paid, due_date, currency, status, last_contact, tags, notes, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()::DATE,$12,$13,$14) RETURNING *`,
      [req.user.id, orgId, name, phone || null, email || null, company || null,
       totalDue || 0, amountPaid || 0, dueDate || null, currency || 'INR',
       status || 'active', tags || '{}', notes || null, metadata ? JSON.stringify(metadata) : '{}']
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateCustomer(req, res, next) {
  try {
    const { name, phone, email, company, totalDue, amountPaid, dueDate, currency, status, healthScore, tags, notes, metadata } = req.body;
    const updates = []; const values = []; let idx = 1;

    if (name !== undefined)        { updates.push(`name = $${idx++}`); values.push(name); }
    if (phone !== undefined)       { updates.push(`phone = $${idx++}`); values.push(phone); }
    if (email !== undefined)       { updates.push(`email = $${idx++}`); values.push(email); }
    if (company !== undefined)     { updates.push(`company = $${idx++}`); values.push(company); }
    if (totalDue !== undefined)    { updates.push(`total_due = $${idx++}`); values.push(totalDue); }
    if (amountPaid !== undefined)  { updates.push(`amount_paid = $${idx++}`); values.push(amountPaid); }
    if (dueDate !== undefined)     { updates.push(`due_date = $${idx++}`); values.push(dueDate); }
    if (currency !== undefined)    { updates.push(`currency = $${idx++}`); values.push(currency); }
    if (status !== undefined)      { updates.push(`status = $${idx++}`); values.push(status); }
    if (healthScore !== undefined) { updates.push(`health_score = $${idx++}`); values.push(healthScore); }
    if (tags !== undefined)        { updates.push(`tags = $${idx++}`); values.push(tags); }
    if (notes !== undefined)       { updates.push(`notes = $${idx++}`); values.push(notes); }
    if (metadata !== undefined)    { updates.push(`metadata = $${idx++}`); values.push(JSON.stringify(metadata)); }

    if (updates.length === 0) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } });

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id, req.user.id);

    await db.query(
      `UPDATE ps_customers SET ${updates.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
      values
    );

    // Fetch the updated row with calculated amount_paid
    const { rows } = await db.query(
      `SELECT c.*, 
              GREATEST(c.amount_paid, COALESCE((SELECT SUM(amount) FROM ps_payments WHERE customer_id = c.id AND status = 'paid'), 0)) as amount_paid
       FROM ps_customers c 
       WHERE c.id = $1 AND c.user_id = $2`,
      [req.params.id, req.user.id]
    );

    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function deleteCustomer(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM ps_customers WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    res.json({ message: 'Customer deleted' });
  } catch (err) { next(err); }
}

// ─── PAYMENTS ────────────────────────────────────────────────────────────────

async function listPayments(req, res, next) {
  try {
    const { customerId, status, limit = 50, offset = 0 } = req.query;
    let sql = `SELECT p.* FROM ps_payments p
               JOIN ps_customers c ON p.customer_id = c.id
               WHERE p.user_id = $1`;
    const params = [req.user.id]; let idx = 2;

    if (customerId) { sql += ` AND p.customer_id = $${idx++}`; params.push(customerId); }
    if (status)     { sql += ` AND p.status = $${idx++}`; params.push(status); }
    sql += ` ORDER BY p.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createPayment(req, res, next) {
  try {
    const { customerId, amount, currency, status, method, paymentMethod, notes, metadata } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ps_payments (customer_id, user_id, amount, currency, status, method, notes, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [customerId, req.user.id, amount, currency || 'INR', status || 'pending',
       method || paymentMethod || null, notes || null, metadata ? JSON.stringify(metadata) : '{}']
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updatePaymentStatus(req, res, next) {
  try {
    const { status } = req.body;
    const { rows } = await db.query(
      `UPDATE ps_payments
       SET status = $1,
           paid_at = CASE WHEN $1 = 'paid' THEN NOW() ELSE paid_at END,
           updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [status, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ─── AUTOMATIONS ─────────────────────────────────────────────────────────────

async function listAutomations(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    let sql = `SELECT * FROM ps_automations WHERE user_id = $1`;
    const params = [req.user.id];
    if (orgId) { sql += ` AND org_id = $2`; params.push(orgId); }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createAutomation(req, res, next) {
  try {
    const orgId = await getOrgId(req.user.id);
    const { name, trigger, action, metadata } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ps_automations (user_id, org_id, name, trigger, action, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, orgId || null, name, trigger, action, metadata ? JSON.stringify(metadata) : '{}']
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function toggleAutomation(req, res, next) {
  try {
    const { rows } = await db.query(
      `UPDATE ps_automations SET active = NOT active, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Automation not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

async function deleteAutomation(req, res, next) {
  try {
    const { rowCount } = await db.query(
      `DELETE FROM ps_automations WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Automation not found' } });
    res.json({ message: 'Automation deleted' });
  } catch (err) { next(err); }
}

// ─── FOLLOW-UPS ──────────────────────────────────────────────────────────────

async function listFollowUps(req, res, next) {
  try {
    const { customerId, status } = req.query;
    let sql = `SELECT * FROM ps_followups WHERE user_id = $1`;
    const params = [req.user.id]; let idx = 2;
    if (customerId) { sql += ` AND customer_id = $${idx++}`; params.push(customerId); }
    if (status)     { sql += ` AND status = $${idx++}`; params.push(status); }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createFollowUp(req, res, next) {
  try {
    const { customerId, task, dueDate, due_date, dueAt, notes } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ps_followups (customer_id, user_id, task, due_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [customerId, req.user.id, task, dueDate || due_date || dueAt || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateFollowUpStatus(req, res, next) {
  try {
    const { status } = req.body;
    const { rows } = await db.query(
      `UPDATE ps_followups
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [status, req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Follow-up not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ─── DOCUMENTS ───────────────────────────────────────────────────────────────

async function listDocuments(req, res, next) {
  try {
    const { customerId } = req.query;
    let sql = `SELECT * FROM ps_documents WHERE user_id = $1`;
    const params = [req.user.id]; let idx = 2;
    if (customerId) { sql += ` AND customer_id = $${idx++}`; params.push(customerId); }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function createDocument(req, res, next) {
  try {
    const { customerId, name, type, fileUrl, status, metadata } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ps_documents (customer_id, user_id, name, type, file_url, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [customerId, req.user.id, name, type || null, fileUrl || null, status || 'pending', metadata ? JSON.stringify(metadata) : '{}']
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

async function updateDocumentStatus(req, res, next) {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(String(status || '').toLowerCase())) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Invalid document status' }
      });
    }
    const { rows } = await db.query(
      `UPDATE ps_documents
       SET status = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [String(status).toLowerCase(), req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Document not found' } });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// ─── ONBOARDING ──────────────────────────────────────────────────────────────

async function listOnboarding(req, res, next) {
  try {
    const { customerId } = req.query;
    let sql = `SELECT * FROM ps_onboarding WHERE user_id = $1`;
    const params = [req.user.id]; let idx = 2;
    if (customerId) { sql += ` AND customer_id = $${idx++}`; params.push(customerId); }
    sql += ` ORDER BY step_order ASC`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
}

async function upsertOnboardingStep(req, res, next) {
  try {
    const { customerId, stepName, stepOrder, status, notes } = req.body;
    const { rows } = await db.query(
      `INSERT INTO ps_onboarding (customer_id, user_id, step_name, step_order, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (customer_id, step_name)
       DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes,
         completed_at = CASE WHEN EXCLUDED.status = 'completed' THEN NOW() ELSE NULL END
       RETURNING *`,
      [customerId, req.user.id, stepName, stepOrder || 0, status || 'pending', notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// ─── AI CUSTOMER ANALYSIS ────────────────────────────────────────────────────

async function analyzeCustomerText(req, res, next) {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Text content is required' }
      });
    }

    const aiExtract = require('../services/gemini.service');
    const analyzer = aiExtract?.analyzeCustomerDetails;
    if (typeof analyzer !== 'function') {
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Customer text analyzer is unavailable' }
      });
    }

    const extractedData = await analyzer(text, 'text');
    if (!extractedData) {
      return res.status(502).json({
        error: { code: 'AI_EXTRACTION_FAILED', message: 'Failed to extract customer details from text' }
      });
    }

    res.json({
      success: true,
      data: extractedData,
      source: 'text'
    });
  } catch (err) {
    next(err);
  }
}

async function analyzeCustomerFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'File is required' }
      });
    }

    const { extractTextFromFile, analyzeCustomerDetails, analyzeMultipleCustomers } = require('../services/gemini.service');

    const { buffer, mimetype, originalname } = req.file;
    const isBulk = req.query.mode === 'bulk';

    // Extract text from file
    const extractedText = await extractTextFromFile(buffer, mimetype, originalname);

    let result;
    if (isBulk) {
      // Analyze as multiple customers
      result = await analyzeMultipleCustomers(extractedText);
    } else {
      // Analyze as single customer
      result = await analyzeCustomerDetails(extractedText, 'file');
    }

    res.json({
      success: true,
      data: result,
      source: 'file',
      filename: originalname,
      isBulk: isBulk
    });
  } catch (err) {
    next(err);
  }
}

// ─── FILE UPLOAD FOR CUSTOMER LIST ───────────────────────────────────────────

async function uploadAndAnalyzeCustomers(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'File is required' }
      });
    }

    const { 
      analyzePdfWithGemini, 
      parseCsvLocally, 
      parseExcelLocally, 
      normalizeHeaders, 
      cleanupHeadersWithAI,
      normalizePhoneNumber,
      removeCustomerDuplicates,
      parseAmount
    } = require('../services/gemini.service');

    const { buffer, mimetype, originalname } = req.file;
    let rawRecords = [];
    let isAI = false;

    if (mimetype === 'application/pdf') {
      isAI = true;
      rawRecords = await analyzePdfWithGemini(buffer);
    } else if (mimetype === 'text/csv' || originalname.endsWith('.csv')) {
      rawRecords = parseCsvLocally(buffer);
    } else if (mimetype.includes('spreadsheet') || mimetype.includes('excel') || originalname.endsWith('.xlsx')) {
      rawRecords = parseExcelLocally(buffer);
    } else {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'Unsupported file type' }
      });
    }

    let customers = [];

    if (isAI) {
      customers = rawRecords;
    } else {
      // Local Parsing post-processing
      let normalized = rawRecords.map(normalizeHeaders);
      
      // AI Cleanup if headers are unclear (check first record)
      if (normalized.length > 0 && (!normalized[0].name || !normalized[0].phone)) {
        const aiMap = await cleanupHeadersWithAI(rawRecords.slice(0, 3));
        if (Object.keys(aiMap).length > 0) {
          normalized = rawRecords.map(row => {
            const mapped = {};
            Object.entries(aiMap).forEach(([orig, target]) => {
              mapped[target] = row[orig];
            });
            // Merge with heuristic normalization if heuristic found something AI didn't
            const heuristic = normalizeHeaders(row);
            return { ...heuristic, ...mapped };
          });
        }
      }
      customers = normalized;
    }

    // Standardize, Validate, and Clean
    let processed = customers
      .map(c => ({
        name: String(c.name || '').trim(),
        phone: normalizePhoneNumber(c.phone),
        email: (c.email || '').toLowerCase().trim() || null,
        totalAmount: parseAmount(c.totalAmount || c.totalDue || 0),
        paidAmount: parseAmount(c.paidAmount || c.amountPaid || 0),
        dueDate: c.dueDate || null,
      }))
      .filter(c => c.name && c.phone); // Rule: Must have name AND phone

    // Deduplicate by phone
    processed = removeCustomerDuplicates(processed);

    res.json({
      success: true,
      customers: processed,
      count: processed.length,
      source: isAI ? 'AI' : 'Local',
      filename: originalname
    });

  } catch (err) {
    next(err);
  }
}

const POST_SALES_COPY = {
  en: {
    pending_payment: 'Hi {{name}}, this is a gentle reminder for your pending payment of {{amount}}. Please share an update when done.',
    partial_payment: 'Hi {{name}}, we received your partial payment. Please share payment proof so we can verify with the owner.',
    pending_document: 'Hi {{name}}, please share the pending documents. We are following up on Day 0, Day 2, and Day 4.',
    ask_rating: 'Hi {{name}}, thank you. Could you rate your post-sales experience from 1 to 10?',
  },
  hi: {
    pending_payment: 'Namaste {{name}}, aapki {{amount}} payment pending hai. Kripya payment update share karein.',
    partial_payment: 'Namaste {{name}}, partial payment receive hua hai. Verification ke liye payment proof share karein.',
    pending_document: 'Namaste {{name}}, kripya pending documents share karein. Hum Day 0, Day 2 aur Day 4 follow-up karenge.',
    ask_rating: 'Namaste {{name}}, dhanyavaad. Kripya apna post-sales experience 1 se 10 tak rate karein.',
  },
  hing: {
    pending_payment: 'Hi {{name}}, aapka {{amount}} payment pending hai. Ho sake to update bhej do.',
    partial_payment: 'Hi {{name}}, partial payment mil gaya. Owner verify ke liye payment proof share kar do.',
    pending_document: 'Hi {{name}}, pending documents share kar do please. Day 0, Day 2, Day 4 follow-up rahega.',
    ask_rating: 'Hi {{name}}, thanks! Post-sales experience ko 1 to 10 rate karoge?',
  },
};

function interpolateTemplate(template, vars) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ''));
}

function resolvePostSalesLocale(preferredLocale, autoLanguageSwitch) {
  const base = String(preferredLocale || 'hing').toLowerCase().split(/[-_]/)[0];
  if (autoLanguageSwitch === false) return POST_SALES_COPY[base] ? base : 'en';
  return POST_SALES_COPY[base] ? base : 'hing';
}

function fallbackPostSalesMessage(kind, vars) {
  const locale = resolvePostSalesLocale(vars.preferredLocale, vars.autoLanguageSwitch);
  const copy = POST_SALES_COPY[locale] || POST_SALES_COPY.en;
  return interpolateTemplate(copy[kind] || POST_SALES_COPY.en.pending_payment, vars);
}

async function suggestCustomerMessage(req, res, next) {
  try {
    const { kind = 'pending_payment', latestUserMessage, history } = req.body || {};
    const { rows } = await db.query(
      `SELECT id, name, total_due, amount_paid, metadata
       FROM ps_customers
       WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    const customer = rows[0];
    if (!customer) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Customer not found' } });
    }
    const metadata = customer.metadata && typeof customer.metadata === 'object' ? customer.metadata : {};
    const amount = `₹${Math.max(0, Number(customer.total_due || 0) - Number(customer.amount_paid || 0)).toLocaleString('en-IN')}`;
    const vars = {
      name: customer.name || 'Customer',
      amount,
      preferredLocale: metadata.preferredLocale || 'hing',
      autoLanguageSwitch: metadata.autoLanguageSwitch !== false,
    };

    if (!latestUserMessage || !vars.autoLanguageSwitch) {
      return res.json({ message: fallbackPostSalesMessage(kind, vars), source: 'template' });
    }

    const aiService = require('../services/ai.service');
    const prior = Array.isArray(history) ? history.slice(-20) : [];
    const msg = `Goal: Draft one short WhatsApp follow-up for "${kind}". Customer: ${vars.name}. Pending amount: ${vars.amount}. Keep it natural and concise.`;
    const aiReply = await aiService.callAIWithMessages(
      [...prior, { role: 'user', content: String(latestUserMessage).slice(0, 8000) }, { role: 'user', content: msg }],
      aiService.systemPromptForChat('whatsapp', { leadPreferredLocale: vars.preferredLocale }),
      { temperature: 0.6 }
    );
    return res.json({ message: aiReply, source: 'ai' });
  } catch (err) {
    next(err);
  }
}

async function claimPaymentDone(req, res, next) {
  try {
    const { paymentId, proofUrl, note } = req.body || {};
    const { rows } = await db.query(
      `SELECT p.*, c.org_id
       FROM ps_payments p
       JOIN ps_customers c ON c.id = p.customer_id
       WHERE p.id = $1 AND p.user_id = $2`,
      [paymentId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    const payment = rows[0];
    await db.query(
      `UPDATE ps_followups
       SET status = 'paused', notes = COALESCE(notes, '') || ' | Paused: payment claim pending verification', updated_at = NOW()
       WHERE customer_id = $1 AND user_id = $2 AND status = 'pending'`,
      [payment.customer_id, req.user.id]
    );
    await db.query(
      `INSERT INTO ps_automations (user_id, org_id, customer_id, name, trigger, action, active, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        req.user.id,
        payment.org_id || null,
        payment.customer_id,
        'Payment claim verification',
        'payment_claim_done',
        'human_verify_receipt',
        true,
        JSON.stringify({ paymentId, proofUrl: proofUrl || null, note: note || null, claimedAt: new Date().toISOString() }),
      ]
    );
    res.json({ success: true, status: 'verification_pending' });
  } catch (err) { next(err); }
}

async function verifyPaymentClaim(req, res, next) {
  try {
    const { paymentId, approved, note } = req.body || {};
    const { rows } = await db.query(
      `SELECT p.* FROM ps_payments p WHERE p.id = $1 AND p.user_id = $2`,
      [paymentId, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Payment not found' } });
    const payment = rows[0];
    if (approved) {
      await db.query(
        `UPDATE ps_payments SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [paymentId]
      );
      await db.query(
        `UPDATE ps_followups
         SET status = 'cancelled', notes = COALESCE(notes, '') || ' | Terminated after human verification', updated_at = NOW()
         WHERE customer_id = $1 AND user_id = $2`,
        [payment.customer_id, req.user.id]
      );
    } else {
      await db.query(
        `UPDATE ps_followups
         SET status = 'pending', notes = COALESCE(notes, '') || ' | Verification rejected by human', updated_at = NOW()
         WHERE customer_id = $1 AND user_id = $2 AND status = 'paused'`,
        [payment.customer_id, req.user.id]
      );
    }
    await db.query(
      `INSERT INTO ps_automations (user_id, customer_id, name, trigger, action, active, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        req.user.id,
        payment.customer_id,
        'Payment claim decision',
        'human_verification',
        approved ? 'terminate_followup_sequence' : 'resume_followup_sequence',
        false,
        JSON.stringify({ paymentId, approved: !!approved, note: note || null, decidedAt: new Date().toISOString() }),
      ]
    );
    res.json({ success: true, approved: !!approved });
  } catch (err) { next(err); }
}

module.exports = {
  listCustomers, getCustomer, createCustomer, updateCustomer, deleteCustomer,
  listPayments, createPayment, updatePaymentStatus,
  listAutomations, createAutomation, toggleAutomation, deleteAutomation,
  listFollowUps, createFollowUp, updateFollowUpStatus,
  listDocuments, createDocument, updateDocumentStatus,
  listOnboarding, upsertOnboardingStep,
  analyzeCustomerText, analyzeCustomerFile, uploadAndAnalyzeCustomers, suggestCustomerMessage,
  claimPaymentDone, verifyPaymentClaim
};
