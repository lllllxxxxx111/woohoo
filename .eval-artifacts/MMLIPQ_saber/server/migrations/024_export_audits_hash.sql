-- Add manifest SHA-256 hash column for integrity verification
-- This lets operators verify that a recorded audit entry matches a manifest file
-- without storing the entire manifest JSON (which is large and contains PII).
ALTER TABLE export_audits ADD COLUMN manifest_sha256 TEXT;
CREATE INDEX IF NOT EXISTS idx_export_audits_hash ON export_audits(manifest_sha256);
