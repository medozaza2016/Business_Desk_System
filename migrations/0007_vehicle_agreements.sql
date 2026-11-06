-- Vehicle agreements (sale + purchase) -------------------------------------------------
-- One table carries both kinds: the paperwork is the same object, only the labels and
-- the default template differ. Money is stored in integer cents; the balance is derived
-- on every read (full - paid) and never written, so it cannot drift from its inputs.

-- Templates now say what they print. Every existing row is a quotation template, which is
-- exactly what the settings studio keeps editing.
ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'quotation';

CREATE INDEX IF NOT EXISTS idx_templates_company_kind ON templates(company_id, kind, version DESC);

CREATE TABLE IF NOT EXISTS agreements (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'purchase')),
  template_id TEXT,

  agreement_number TEXT NOT NULL,
  agreement_date TEXT NOT NULL,

  -- vehicle
  vehicle_model TEXT NOT NULL,
  vehicle_year TEXT NOT NULL,
  vehicle_chassis TEXT NOT NULL,
  vehicle_plate TEXT NOT NULL DEFAULT '',
  vehicle_color TEXT NOT NULL DEFAULT '',
  vehicle_odometer TEXT NOT NULL DEFAULT '',
  vehicle_registration_place TEXT NOT NULL DEFAULT '',

  -- seller (the party handing the vehicle over)
  seller_name TEXT NOT NULL,
  seller_id_number TEXT NOT NULL DEFAULT '',
  seller_phone TEXT NOT NULL DEFAULT '',
  seller_address TEXT NOT NULL DEFAULT '',

  -- buyer (the party taking the vehicle over)
  buyer_name TEXT NOT NULL,
  buyer_id_number TEXT NOT NULL DEFAULT '',
  buyer_phone TEXT NOT NULL DEFAULT '',
  buyer_address TEXT NOT NULL DEFAULT '',

  -- optional broker; sale agreements usually carry one, purchase agreements rarely do
  intermediary_name TEXT NOT NULL DEFAULT '',
  intermediary_phone TEXT NOT NULL DEFAULT '',
  intermediary_commission TEXT NOT NULL DEFAULT '',

  -- agreed figures, in fils/cents; balance = full - paid is computed, never stored
  full_amount_cents INTEGER NOT NULL DEFAULT 0,
  paid_amount_cents INTEGER NOT NULL DEFAULT 0,
  full_amount_words TEXT NOT NULL DEFAULT '',
  paid_amount_words TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'AED',
  notes TEXT NOT NULL DEFAULT '',

  template_html_snapshot TEXT NOT NULL,
  company_snapshot_json TEXT NOT NULL DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'issued',
  completed_at TEXT,
  share_token TEXT,
  share_token_created_at TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

-- A number is spent once per company, across both kinds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_number ON agreements(company_id, agreement_number);
-- The ledger reads by kind, newest paper first, and the same index serves the search filter.
CREATE INDEX IF NOT EXISTS idx_agreements_ledger ON agreements(company_id, kind, agreement_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agreements_deleted ON agreements(company_id, deleted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreements_share_token ON agreements(share_token)
  WHERE share_token IS NOT NULL;

-- One counter per company, kind and year: SA-2026-00001 and PA-2026-00001 never collide.
CREATE TABLE IF NOT EXISTS agreement_sequences (
  company_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  period TEXT NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, kind, period)
);

-- Same shape as quotation_scans: one signed page per record, the bytes live in R2.
CREATE TABLE IF NOT EXISTS agreement_scans (
  agreement_id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'scan',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agreement_scans_company ON agreement_scans(company_id);
