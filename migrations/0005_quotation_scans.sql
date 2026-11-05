-- The signed copy of a quotation.
--
-- One page per quotation: a re-scan replaces the stored copy instead of piling up
-- versions (the desk cares about *the* signed sheet, not its history — the audit
-- trail keeps the history). Image bytes live in R2 under scans/<company>/…; this
-- table only keeps the key plus the measurements the record page prints in mono.
CREATE TABLE IF NOT EXISTS quotation_scans (
  quotation_id TEXT PRIMARY KEY REFERENCES quotations(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  source       TEXT NOT NULL DEFAULT 'scan',
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scans_company ON quotation_scans(company_id, created_at DESC);
