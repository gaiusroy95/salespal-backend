-- Migration 031: Add invoice_number to payments table

ALTER TABLE payments ADD COLUMN IF NOT EXISTS invoice_number VARCHAR(50) UNIQUE;

CREATE INDEX IF NOT EXISTS idx_payments_invoice_number ON payments(invoice_number);

COMMIT;
