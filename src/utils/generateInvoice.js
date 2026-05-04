const PDFDocument = require('pdfkit');

/**
 * Generates an invoice PDF and pipes it to the HTTP response
 * @param {object} res - Express response object
 * @param {object} payment - Payment row from the database
 */
function generateInvoice(res, payment) {
  const doc = new PDFDocument({ margin: 50 });

  // Pipe the PDF directly to the response object instead of saving to disk
  doc.pipe(res);

  // Parse items safely
  let items = [];
  try {
    items = typeof payment.items === 'string' ? JSON.parse(payment.items) : payment.items;
  } catch (err) {
    items = [];
  }

  // ── HEADER ──────────────────────────────────────────────────────────────
  doc
    .fillColor('#1F2937')
    .fontSize(28)
    .font('Helvetica-Bold')
    .text('SalesPal', { align: 'center' })
    .moveDown(0.25);

  doc
    .fontSize(14)
    .font('Helvetica')
    .fillColor('#6B7280')
    .text('INVOICE', { align: 'center' })
    .moveDown(2);

  // Formatting invoice dates uniquely
  const invoiceDate = payment.created_at ? new Date(payment.created_at).toLocaleDateString() : new Date().toLocaleDateString();
  const invoiceId = payment.id || payment.razorpay_order_id || 'N/A';
  
  doc
    .fontSize(10)
    .fillColor('#374151')
    .text(`Invoice Number: ${invoiceId}`, 50, doc.y)
    .text(`Date Issued: ${invoiceDate}`, 50, doc.y + 15)
    .moveDown(2.5);

  // ── CUSTOMER INFO ───────────────────────────────────────────────────────
  const customerId = payment.user_id || 'Guest Customer';
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .text('Billed To:', 50, doc.y)
    .fontSize(10)
    .font('Helvetica')
    .text(`User ID: ${customerId}`, 50, doc.y + 15)
    .moveDown(3);

  // ── ITEM TABLE HEADER ───────────────────────────────────────────────────
  let startY = doc.y;

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#111827')
    .text('Product / Service', 50, startY)
    .text('Quantity', 350, startY)
    .text('Amount', 450, startY);

  doc.moveDown(0.5);
  doc
    .moveTo(50, doc.y)
    .lineTo(550, doc.y)
    .strokeColor('#E5E7EB')
    .stroke();
  doc.moveDown(1);

  // ── ITEM TABLE DATA ─────────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(10).fillColor('#374151');
  
  // Note: Standard checkout calculates total amount dynamically, saving it under total_amount.
  // We may not explicitly have granular `pricing` cached per item in JSON array, 
  // so we present the known parameters safely per row.
  for (const item of items) {
    const productKey = item.productType || '';
    const formattedName = productKey 
      ? productKey.charAt(0).toUpperCase() + productKey.slice(1).replace('-', ' ') 
      : 'Subscription Plan';
      
    const quantity = item.quantity || 1;

    let currentY = doc.y;
    doc.text(formattedName, 50, currentY);
    doc.text(quantity.toString(), 350, currentY);
    doc.text('-', 450, currentY); // Precise granular price fallback if not statically bounded inside db array
    
    doc.moveDown(1);
  }

  // Bottom border of items
  doc.moveDown(0.5);
  doc
    .moveTo(50, doc.y)
    .lineTo(550, doc.y)
    .stroke();
  doc.moveDown(1.5);

  // ── FOOTER & TOTALS ─────────────────────────────────────────────────────
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .fillColor('#111827')
    .text('Total Amount Paid:', 300, doc.y, { continued: true })
    .text(`Rs. ${payment.total_amount || 0}`, 450, doc.y);

  doc.moveDown(4);

  // Thank you message
  doc
    .fontSize(10)
    .font('Helvetica-Oblique')
    .fillColor('#9CA3AF')
    .text('Thank you for choosing SalesPal!', 50, doc.y, { align: 'center' });

  // Finalize PDF rendering
  doc.end();
}

module.exports = { generateInvoice };
