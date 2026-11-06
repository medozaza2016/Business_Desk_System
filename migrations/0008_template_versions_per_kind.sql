-- Templates: one version line per kind ---------------------------------------------------
-- 0001 declared UNIQUE(company_id, version), which was right while every template was a
-- quotation sheet. 0007 added `kind`, and each kind numbers its own versions from v1 — so
-- publishing "Sale agreement v1" while "Quotation v1" exists hit the old key and the
-- request failed with a bare 500. SQLite cannot drop an inline UNIQUE, so the table is
-- rebuilt with the key widened to (company_id, kind, version). Nothing else changes: the
-- same columns, the same rows, the same ids, so quotations.template_id stays valid.
--
-- D1 runs a migration inside one transaction; deferring the foreign-key check lets the
-- rows move from the old table to the new one before the constraint is verified.

PRAGMA defer_foreign_keys = true;

CREATE TABLE templates_v2 (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'quotation',
  version INTEGER NOT NULL,
  html TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, kind, version)
);

INSERT INTO templates_v2(id, company_id, name, kind, version, html, active, created_at)
  SELECT id, company_id, name, kind, version, html, active, created_at FROM templates;

DROP TABLE templates;

ALTER TABLE templates_v2 RENAME TO templates;

-- The live-version lookup the studio and both print paths make.
CREATE INDEX IF NOT EXISTS idx_templates_company ON templates(company_id, active, version DESC);
CREATE INDEX IF NOT EXISTS idx_templates_company_kind ON templates(company_id, kind, version DESC);
