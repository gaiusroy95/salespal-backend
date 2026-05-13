const { parse } = require('csv-parse/sync');
const pdfParse = require('pdf-parse');
const logger = require('../config/logger');

/**
 * Parse a CSV buffer into an array of lead objects.
 * Accepts flexible column names (case-insensitive).
 */
function parseCsvLeads(buffer) {
  const records = parse(buffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });

  return records.map((row, i) => normaliseLead(row, i));
}

/**
 * Parse a PDF buffer and extract leads from text content.
 * Looks for lines containing phone numbers and emails.
 *
 * @returns {Promise<{
 *   leads: Array<{ name: string|null, email: string|null, phone: string|null, source: string }>,
 *   issues: string[],
 *   textLength: number,
 *   numpages: number,
 *   parseFailed?: boolean
 * }>}
 */
async function parsePdfLeads(buffer) {
  if (!buffer || buffer.length === 0) {
    return {
      leads: [],
      issues: ['The uploaded file was empty.'],
      textLength: 0,
      numpages: 0,
      parseFailed: true,
    };
  }

  let data;
  try {
    data = await pdfParse(buffer);
  } catch (err) {
    logger.warn(`[leadUpload] PDF parse failed: ${err.message}`);
    const msg = String(err.message || err);
    const issues = [
      'This file could not be read as a valid PDF (it may be corrupted, renamed from another format, or not a real PDF).',
    ];
    if (/password|encrypt/i.test(msg)) {
      issues.push('Password-protected PDFs are not supported — remove the password and upload again.');
    }
    return {
      leads: [],
      issues,
      textLength: 0,
      numpages: 0,
      parseFailed: true,
    };
  }

  const text = String(data.text || '').trim();
  const textLength = text.length;
  const numpages = Number(data.numpages) || 0;

  if (textLength < 30) {
    return {
      leads: [],
      issues: [
        'Almost no text could be extracted from this PDF.',
        'If every page is a scanned image, our importer cannot read phone numbers or emails — use a text-based PDF, run OCR first, or use CSV / manual entry.',
      ],
      textLength,
      numpages,
    };
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const leads = [];
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const phoneRe = /(\+?\d[\d\s\-().]{7,}\d)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const emailMatch = line.match(emailRe);
    const phoneMatch = line.match(phoneRe);

    if (emailMatch || phoneMatch) {
      const nameLine = i > 0 ? lines[i - 1] : '';
      const isNameLike =
        nameLine && !nameLine.match(emailRe) && !nameLine.match(phoneRe) && nameLine.length < 60;

      leads.push({
        name: isNameLike ? nameLine : null,
        email: emailMatch ? emailMatch[0] : null,
        phone: phoneMatch ? phoneMatch[1].replace(/\s+/g, '') : null,
        source: 'PDF Upload',
      });
    }
  }

  const seen = new Set();
  const deduped = leads.filter((l) => {
    const key = `${l.email || ''}|${l.phone || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    return {
      leads: [],
      issues: [
        'No phone numbers or email addresses were found in the PDF text.',
        'Put contact details in selectable text (not only inside images, diagrams, or flattened artwork).',
      ],
      textLength,
      numpages,
    };
  }

  return { leads: deduped, issues: [], textLength, numpages };
}

/**
 * Normalise a raw CSV row into a consistent lead shape.
 */
function normaliseLead(row, index) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(row).find(
        (rk) => rk.toLowerCase().replace(/[\s_-]/g, '') === k.toLowerCase().replace(/[\s_-]/g, '')
      );
      if (found && row[found]) return row[found].trim();
    }
    return null;
  };

  return {
    name:
      get('name', 'fullname', 'full_name', 'contactname', 'contact_name') ||
      [get('firstname', 'first_name'), get('lastname', 'last_name')].filter(Boolean).join(' ') ||
      `Lead ${index + 1}`,
    email: get('email', 'emailaddress', 'email_address'),
    phone: get('phone', 'phonenumber', 'phone_number', 'mobile', 'cell', 'contact'),
    company: get('company', 'companyname', 'company_name', 'organization', 'organisation'),
    source: get('source', 'leadsource', 'lead_source') || 'CSV Upload',
  };
}

module.exports = {
  parseCsvLeads,
  parsePdfLeads,
};
