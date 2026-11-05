CREATE TABLE IF NOT EXISTS admin_users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
 password_iterations INTEGER NOT NULL DEFAULT 210000,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS companies (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
 legal_name TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '', address TEXT DEFAULT '',
 quotation_prefix TEXT NOT NULL DEFAULT 'QA-', currency TEXT NOT NULL DEFAULT 'AED',
 logo_key TEXT, letterhead_key TEXT, font_key TEXT, font_name TEXT NOT NULL DEFAULT 'Arial',
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS templates (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 name TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(company_id, version)
);
CREATE INDEX IF NOT EXISTS idx_templates_company ON templates(company_id, active, version DESC);
CREATE TABLE IF NOT EXISTS quote_sequences (
 company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 period TEXT NOT NULL, last_number INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(company_id, period)
);
CREATE TABLE IF NOT EXISTS quotations (
 id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id),
 template_id TEXT REFERENCES templates(id), quote_number TEXT NOT NULL, quote_date TEXT NOT NULL,
 model TEXT NOT NULL, year TEXT NOT NULL, chassis TEXT NOT NULL, amount_cents INTEGER NOT NULL,
 amount_words TEXT NOT NULL, template_html_snapshot TEXT NOT NULL, company_snapshot_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 deleted_at TEXT, UNIQUE(company_id, quote_number)
);
CREATE INDEX IF NOT EXISTS idx_quotes_company_date ON quotations(company_id, quote_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_company_number ON quotations(company_id, quote_number);
CREATE TABLE IF NOT EXISTS login_attempts (
 id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT NOT NULL, attempted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_hash, attempted_at);
