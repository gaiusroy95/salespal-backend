const pdfParse = require('pdf-parse');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const logger = require('../config/logger');
const aiService = require('./ai.service');

const EXTRACTION_SYSTEM_PROMPT = `You are a strict data extraction engine.
Return valid JSON only. No markdown, no prose, no code fences.
Prefer null/empty values when unsure.`;

async function callAiForJson(userPrompt, mode = 'object') {
  const text = await aiService.callAI(userPrompt, EXTRACTION_SYSTEM_PROMPT);
  const match = mode === 'array'
    ? text.match(/\[[\s\S]*\]/)
    : text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error('Failed to parse AI JSON response');
  }
  return JSON.parse(match[0]);
}

// Extract text from different file types
const extractTextFromFile = async (buffer, mimeType, filename) => {
  try {
    if (mimeType === 'application/pdf') {
      const data = await pdfParse(buffer);
      return data.text;
    }

    if (mimeType === 'text/csv' || filename.endsWith('.csv')) {
      const text = buffer.toString('utf-8');
      return text;
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel' ||
      filename.endsWith('.xlsx') ||
      filename.endsWith('.xls') ||
      filename.endsWith('.csv')
    ) {
      // For Excel files we parse to rows elsewhere.
      return buffer.toString('utf-8');
    }

    // Plain text files
    return buffer.toString('utf-8');
  } catch (error) {
    logger.error('Error extracting text from file:', error);
    throw new Error(`Failed to extract text from ${filename}: ${error.message}`);
  }
};

// Helper function to parse number from various formats
const parseAmount = (value) => {
  if (!value) return 0;
  if (typeof value === 'number') return Math.max(0, value);
  const str = String(value).replace(/[₹$,]/g, '').trim();
  const num = parseInt(str);
  return isNaN(num) ? 0 : Math.max(0, num);
};

// Helper function to clean phone number
const cleanPhone = (phone) => {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-10) || '';
};

// Helper function to parse email
const parseEmail = (email) => {
  if (!email || typeof email !== 'string') return '';
  const cleaned = email.trim();
  if (cleaned.includes('@')) return cleaned;
  return '';
};

// Helper function to extract email using regex from text
const extractEmailFromText = (text) => {
  if (!text) return '';
  const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
  const matches = text.match(emailRegex);
  if (matches && matches.length > 0) {
    return matches[0].toLowerCase();
  }
  return '';
};

// Helper function to extract amount paid using regex from text
const extractAmountPaidFromText = (text) => {
  if (!text) return 0;
  
  // Keywords that indicate "paid" amount
  const paidKeywords = ['paid', 'already paid', 'payment received', 'amount paid', 'advance', 'deposit', 'transferred', 'cleared', 'settled'];
  
  for (const keyword of paidKeywords) {
    const regex = new RegExp(`(?:${keyword})\\s*(?:of)?\\s*(?:₹|Rs\\.?|\\$)?\\s*([\\d,]+(?:\\.\\d+)?)`, 'gi');
    const matches = regex.exec(text);
    if (matches && matches[1]) {
      const amount = parseInt(matches[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }
  return 0;
};

// Helper function to extract total amount using regex from text
const extractTotalDueFromText = (text) => {
  if (!text) return 0;
  
  // Keywords that indicate total amount
  const totalKeywords = ['owes', 'total', 'invoice', 'amount', 'due', 'outstanding', 'pending'];
  
  for (const keyword of totalKeywords) {
    // Look for the main amount (usually the first/largest number after these keywords)
    const regex = new RegExp(`(?:${keyword})\\s*(?:of)?\\s*(?:₹|Rs\\.?|\\$)?\\s*([\\d,]+(?:\\.\\d+)?)`, 'gi');
    const matches = regex.exec(text);
    if (matches && matches[1]) {
      const amount = parseInt(matches[1].replace(/,/g, ''));
      if (!isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }
  return 0;
};

// Analyze single customer details from text using Gemini-backed AI service
const analyzeCustomerDetails = async (content, sourceType = 'text') => {
  try {
    const prompt = `Extract customer payment details from this content.
Return exactly one JSON object with these keys:
{
  "name": "full customer name",
  "phone": "digits only",
  "email": "valid email or empty string",
  "company": "company name or empty string",
  "totalDue": number,
  "amountPaid": number,
  "dueDate": "YYYY-MM-DD or null",
  "currency": "INR or USD",
  "notes": "short notes"
}
Content:
${content}`;

    const data = await callAiForJson(prompt, 'object');
    const extractedData = {
      name: (data.name && data.name.trim()) || '',
      phone: cleanPhone(data.phone || ''),
      email: parseEmail(data.email || ''),
      company: (data.company && data.company.trim()) || '',
      totalDue: parseAmount(data.totalDue),
      amountPaid: parseAmount(data.amountPaid),
      dueDate: data.dueDate || null,
      currency: data.currency || 'INR',
      notes: (data.notes && data.notes.trim()) || ''
    };

    // Fallback: If email is empty, try regex extraction from original content
    if (!extractedData.email) {
      const regexEmail = extractEmailFromText(content);
      if (regexEmail) {
        logger.info('Email extracted via regex fallback:', regexEmail);
        extractedData.email = regexEmail;
      }
    }

    // Fallback: If amountPaid is 0, try regex extraction from original content
    if (!extractedData.amountPaid || extractedData.amountPaid === 0) {
      const regexPaid = extractAmountPaidFromText(content);
      if (regexPaid && regexPaid > 0) {
        logger.info('Amount paid extracted via regex fallback:', regexPaid);
        extractedData.amountPaid = regexPaid;
      }
    }

    // Fallback: If totalDue is 0, try regex extraction from original content
    if (!extractedData.totalDue || extractedData.totalDue === 0) {
      const regexTotal = extractTotalDueFromText(content);
      if (regexTotal && regexTotal > 0) {
        logger.info('Total due extracted via regex fallback:', regexTotal);
        extractedData.totalDue = regexTotal;
      }
    }

    // Calculate remaining due
    extractedData.remaining = Math.max(0, extractedData.totalDue - extractedData.amountPaid);

    logger.info('Customer details extracted successfully:', extractedData);
    return extractedData;
  } catch (error) {
    logger.error('Error analyzing customer details with AI service:', error);
    return null;
  }
};

/**
 * Local CSV Parsing (No AI)
 */
const parseCsvLocally = (buffer) => {
  try {
    const records = parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
    return records;
  } catch (error) {
    logger.error('CSV Parsing Error:', error);
    throw new Error('Failed to parse CSV file locally');
  }
};

/**
 * Local Excel Parsing (No AI)
 */
const parseExcelLocally = (buffer) => {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const records = XLSX.utils.sheet_to_json(worksheet);
    return records;
  } catch (error) {
    logger.error('Excel Parsing Error:', error);
    throw new Error('Failed to parse Excel file locally');
  }
};

/**
 * Normalize headers based on common variations
 */
const normalizeHeaders = (row) => {
  const normalized = {};
  const keys = Object.keys(row);

  const findKey = (variations) => {
    return keys.find(k => {
      const cleanK = k.toLowerCase().replace(/[\s_-]/g, '');
      return variations.some(v => cleanK === v.toLowerCase().replace(/[\s_-]/g, ''));
    });
  };

  const nameKey = findKey(['name', 'fullname', 'customer', 'customername', 'client']);
  const phoneKey = findKey(['phone', 'mobile', 'contact', 'phonenumber', 'cell', 'whatsapp']);
  const emailKey = findKey(['email', 'emailaddress', 'mail']);
  const totalAmountKey = findKey(['totalamount', 'total', 'amount', 'totaldue', 'invoiceamount', 'billamount']);
  const paidAmountKey = findKey(['paidamount', 'paid', 'amountpaid', 'received', 'advance']);
  const dueDateKey = findKey(['duedate', 'date', 'due', 'paymentdate']);

  if (nameKey) normalized.name = row[nameKey];
  if (phoneKey) normalized.phone = row[phoneKey];
  if (emailKey) normalized.email = row[emailKey];
  if (totalAmountKey) normalized.totalAmount = row[totalAmountKey];
  if (paidAmountKey) normalized.paidAmount = row[paidAmountKey];
  if (dueDateKey) normalized.dueDate = row[dueDateKey];

  return normalized;
};

/**
 * AI Header Cleanup (Optional - only if headers are unclear)
 */
const cleanupHeadersWithAI = async (sampleRows) => {
  try {
    const prompt = `Match the headers from this JSON sample to these fields: name, phone, email, totalAmount, paidAmount, dueDate.
    
    Sample Data: ${JSON.stringify(sampleRows)}
    
    Return ONLY a JSON mapping object: {"originalHeader": "targetField"}.
    If a field is not found, do not include it.`;

    const mapping = await callAiForJson(prompt, 'object');
    return mapping && typeof mapping === 'object' ? mapping : {};
  } catch (error) {
    logger.error('AI header cleanup error:', error);
    return {};
  }
};



// Analyze multiple rows from CSV/Excel/text
const analyzeMultipleCustomers = async (content) => {
  try {
    const prompt = `Extract every customer from this tabular/unstructured data.
Return a valid JSON array only. Each item must include:
{
  "name": "full customer name",
  "phone": "only digits (0-9)",
  "email": "xxx@xxx.com format",
  "company": "company name",
  "totalDue": a number (not string),
  "amountPaid": a number (not string),
  "dueDate": "YYYY-MM-DD",
  "currency": "INR or USD",
  "notes": "any info"
}
Data to analyze:
${content}`;
    let customers = await callAiForJson(prompt, 'array');

    // Validate and clean data using improved parsing
    customers = Array.isArray(customers)
      ? customers.map((c) => {
          let customer = {
            name: (c.name && c.name.trim()) || '',
            phone: cleanPhone(c.phone || ''),
            email: parseEmail(c.email || ''),
            company: (c.company && c.company.trim()) || '',
            totalDue: parseAmount(c.totalDue),
            amountPaid: parseAmount(c.amountPaid),
            dueDate: c.dueDate || null,
            currency: c.currency || 'INR',
            notes: (c.notes && c.notes.trim()) || '',
            remaining: 0
          };

          // Additional regex extraction as fallback for critical fields
          if (!customer.email && c.email === '') {
            // Try to find email pattern in any field
            const allText = Object.values(c).join(' ');
            const regexEmail = extractEmailFromText(allText);
            if (regexEmail) {
              customer.email = regexEmail;
            }
          }

          if (!customer.amountPaid || customer.amountPaid === 0) {
            const regexPaid = extractAmountPaidFromText(
              Object.values(c).join(' ')
            );
            if (regexPaid && regexPaid > 0) {
              customer.amountPaid = regexPaid;
            }
          }

          // Calculate remaining due
          customer.remaining = Math.max(0, customer.totalDue - customer.amountPaid);
          return customer;
        })
      : [];

    logger.info(`${customers.length} customers extracted successfully via AI service`);
    return customers;
  } catch (error) {
    logger.error('Error analyzing multiple customers with AI service:', error);
    throw error;
  }
};


// Helper to normalize phone number
const normalizePhoneNumber = (phone) => {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-10) || digits;
};

// Helper to remove duplicate customers by phone number
const removeCustomerDuplicates = (customers) => {
  const seen = new Set();
  return customers.filter(customer => {
    const phone = normalizePhoneNumber(customer.phone);
    if (phone && seen.has(phone)) {
      return false;
    }
    if (phone) {
      seen.add(phone);
    }
    return true;
  });
};

// Analyze PDF with Gemini-backed AI by text extraction + structured parsing
const analyzePdfWithGemini = async (pdfBuffer) => {
  try {
    logger.info('Extracting customer data from PDF via AI service...');
    const { text } = await pdfParse(pdfBuffer);
    if (!text || !text.trim()) return [];
    let customers = await analyzeMultipleCustomers(text);
    
    // Validate and clean customers
    customers = Array.isArray(customers)
      ? customers.map((c) => ({
          name: (c.name && c.name.trim()) || '',
          phone: cleanPhone(c.phone || ''),
          email: parseEmail(c.email || ''),
          company: (c.company && c.company.trim()) || null,
          totalAmount: parseAmount(c.totalAmount || c.totalDue || 0),
          paidAmount: parseAmount(c.paidAmount || c.amountPaid || 0),
          dueDate: c.dueDate || null,
          currency: 'INR'
        }))
      : [];

    customers = removeCustomerDuplicates(customers);
    return customers;
  } catch (error) {
    logger.error('Error analyzing PDF with AI service:', error);
    throw error;
  }
};



module.exports = {
  extractTextFromFile,
  analyzeCustomerDetails,
  analyzeMultipleCustomers,
  analyzePdfWithGemini,
  parseCsvLocally,
  parseExcelLocally,
  normalizeHeaders,
  cleanupHeadersWithAI,
  normalizePhoneNumber,
  removeCustomerDuplicates,
  cleanPhone,
  parseAmount
};
