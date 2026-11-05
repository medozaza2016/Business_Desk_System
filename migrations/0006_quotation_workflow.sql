-- Workflow state for a quotation, plus the token behind its public share link.
--
-- status          'issued' → a record exists; 'completed' → the job is closed.
--                 "signed" is not stored: it is derived from quotation_scans, so the
--                 two can never disagree.
-- share_token     the unguessable path segment of /s/<token>; NULL means no link.
--                 Minted when the signed copy is stored, rotated or revoked on demand.
ALTER TABLE quotations ADD COLUMN status TEXT NOT NULL DEFAULT 'issued';
ALTER TABLE quotations ADD COLUMN completed_at TEXT;
ALTER TABLE quotations ADD COLUMN share_token TEXT;
ALTER TABLE quotations ADD COLUMN share_token_created_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_share_token ON quotations(share_token);
