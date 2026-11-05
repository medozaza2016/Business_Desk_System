-- Simplifies authentication to a single shared passcode stored in `settings`,
-- plus a lightweight audit trail. The three auth tables from 0001 are dropped:
-- they are empty (admin_users/sessions/login_attempts) and are superseded by
-- stateless, HMAC-signed session cookies.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS admin_users;
DROP TABLE IF EXISTS login_attempts;

CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY,
 actor TEXT NOT NULL,
 action TEXT NOT NULL,
 entity TEXT NOT NULL,
 entity_id TEXT,
 details_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
