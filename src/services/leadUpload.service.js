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
 */
async function parsePdfLeads(buffer) {
  const data = await pdfParse(buffer);
  const text = data.text || '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const leads = [];
  const emailRe = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  const phoneRe = /(\+?\d[\d\s\-().]{7,}\d)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const emailMatch = line.match(emailRe);
    const phoneMatch = line.match(phoneRe);

    if (emailMatch || phoneMatch) {
      // Try to grab a name from the previous line
      const nameLine = i > 0 ? lines[i - 1] : '';
      const isNameLike = nameLine && !nameLine.match(emailRe) && !nameLine.match(phoneRe) && nameLine.length < 60;

      leads.push({
        name: isNameLike ? nameLine : null,
        email: emailMatch ? emailMatch[0] : null,
        phone: phoneMatch ? phoneMatch[1].replace(/\s+/g, '') : null,
        source: 'PDF Upload',
      });
    }
  }

  // Deduplicate by email+phone
  const seen = new Set();
  return leads.filter(l => {
    const key = `${l.email || ''}|${l.phone || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Normalise a raw CSV row into a consistent lead shape.
 */
function normaliseLead(row, index) {
  const get = (...keys) => {
    for (const k of keys) {
      const found = Object.keys(row).find(rk => rk.toLowerCase().replace(/[\s_-]/g, '') === k.toLowerCase().replace(/[\s_-]/g, ''));
      if (found && row[found]) return row[found].trim();
    }
    return null;
  };

  return {
    name: get('name', 'fullname', 'full_name', 'contactname', 'contact_name') ||
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
