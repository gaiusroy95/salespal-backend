-- Migration 032: Backfill invoice_number for existing payments

ALTER TABLE payments DISABLE TRIGGER update_payments_updated_at;

UPDATE payments 
SET invoice_number = 'INV-' || to_char(NOW(), 'YYMM') || '-' || LPAD(CAST(id::text AS TEXT), 6, '0')
WHERE invoice_number IS NULL;

ALTER TABLE payments ENABLE TRIGGER update_payments_updated_at;

COMMIT;
