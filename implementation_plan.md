# Vehicle Agreements module — implementation plan

Status: implemented. Covers milestone 2 of the desk: vehicle **sale** and **purchase**
agreements, built on the quotation workflow (kind-filtered ledger, 6-step wizard,
two A4 templates rendered from the database, signed-copy scanning, share links and
CSV parity).

The quotation plan this replaces is in git history (`git log -p -- implementation_plan.md`).

## 1. Goal

Give each company a second document type that behaves exactly like a quotation where
it matters — numbering, printing, signed copies, public hand-off, retention — while
carrying the fields an agreement needs: two parties, vehicle specification, agreed
price, deposit/full payment and the balance.

## 2. Confirmed decisions

| Decision | Choice |
| --- | --- |
| Storage | **one** `agreements` table with a `kind` column (`sale` \| `purchase`) |
| UI | **one** wizard and **one** record page for both kinds; the kind only changes labels and the default template |
| Numbering | `agreement_sequences(company_id, kind, period)`, serial `00001`+, numbers `SA-<year>-00001` / `PA-<year>-00001` |
| Quotation numbering | untouched (`quote_sequences`, company prefix, `QA-…`) |
| Templates | `templates.kind` (`quotation` default). Settings studio keeps editing quotation templates; agreement templates are published through the API and snapshotted per record |
| Money | stored as integer cents (`full_amount_cents`, `paid_amount_cents`); `balance` is **derived** on every read, never stored |
| Deletion | soft delete → restore → permanent delete (confirm the agreement number), same as quotations |
| Public link | new `/a/<token>` namespace; `/s/<token>` stays quotation-only |
| Audit | `agreement.created/updated/cancelled/restored/permanently_deleted/completed/reopened/scan_uploaded/scan_removed/share_link_created/share_link_rotated/share_link_revoked` |

## 3. Schema — `migrations/0007_vehicle_agreements.sql`

- `ALTER TABLE templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'quotation'` (+ index).
- `agreements`: kind, number, date, vehicle block (model, year, chassis, plate, colour,
  odometer, registration place), seller block, buyer block, optional intermediary,
  `full_amount_cents`, `paid_amount_cents`, words columns, `currency`, `notes`,
  `template_html_snapshot`, `company_snapshot_json`, status, `completed_at`,
  `share_token(_created_at)`, timestamps, `deleted_at`.
- Unique `(company_id, agreement_number)`; ledger index `(company_id, kind, agreement_date DESC, created_at DESC)`;
  partial index on `share_token`.
- `agreement_sequences(company_id, kind, period, last_number)` — primary key on the triple.
- `agreement_scans(agreement_id, company_id, r2_key, content_type, bytes, width, height, source, created_at)`.

Nothing is seeded: an agreement printed before anyone publishes a template uses the
built-in default HTML, which is still snapshotted into the record.

## 4. Worker (`src/index.js`)

Helpers (mirroring the quotation ones so the two paths read the same):

- `agreementKindOf`, `agreementNumberFor`, `peekNextAgreementNumber`, `allocateAgreementSerial`
- `decorateAgreement` (money + `DMY` date + `balance` + kind label)
- `agreementPayload` (row + workflow block + live company), `agreementScanPayload`
- `companyPrintFields` extracted from `buildPrintFields` so both print paths share the
  branding rules; `buildAgreementPrintFields` adds the agreement placeholders.

Routes under `/api/agreements`:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/agreements?company_id&kind&view&sort&q` | ledger, active or deleted |
| GET | `/api/agreements/next-number?company_id&kind&date` | read-only preview |
| POST | `/api/agreements` | server allocates the number, snapshots template + company |
| GET | `/api/agreements/:id` | record payload |
| PATCH | `/api/agreements/:id` | edits (refused while completed) |
| DELETE | `/api/agreements/:id` | cancel (soft delete) |
| POST | `/api/agreements/:id/restore` | back to the ledger |
| DELETE | `/api/agreements/:id/permanent` | confirm number, deletes scan + R2 object |
| GET | `/api/agreements/:id/print` | A4 sheet, `?print=1` autoprints |
| GET/POST/DELETE | `/api/agreements/:id/scan` | signed copy |
| PATCH | `/api/agreements/:id/status` | completed / reopened (needs a scan to complete) |
| POST/DELETE | `/api/agreements/:id/share-link` | mint/rotate, revoke |
| GET | `/api/export/agreements.csv?company_id&kind` | CSV parity |

Template routes learn `kind`: `GET /api/companies/:id/templates?kind=sale`,
`POST …/templates` accepts `kind` (default `quotation`) and versions per kind,
`POST /api/templates/:id/activate` scopes `active` to the template's own kind.
Company permanent delete / delete-summary now count and remove agreements,
agreement sequences and agreement scans.

Public share: `/a/<token>` and `/a/<token>/scan`, rendered by `src/agreement-share.js`
on the same shell as the quotation page.

## 5. Templates

`templates/default-sales-agreement.html` and `templates/default-purchase-agreement.html`
— self-contained A4 documents (letterhead, logo, bilingual lockup, parties, vehicle,
financial terms, terms, signatures), driven only by placeholders:

`agreement_number`, `agreement_date`, `agreement_kind`, `vehicle_*`, `seller_*`,
`buyer_*`, `intermediary_*`, `full_amount(_words)`, `paid_amount(_words)`,
`balance(_words)`, `currency`, `has_intermediary`, `notes`, plus the shared
`company_*` / `logo_url` / `logo_state` / `letterhead_url` block.

## 6. Client

- `public/index.html`: the “Coming soon” panel becomes the agreements ledger
  (kind switch, search, sort, active/deleted views, CSV, “New agreement”), plus a
  six-step wizard dialog.
- `public/app.js`: agreements state, list rendering, restore/permanent delete,
  wizard wiring, audit labels for the new actions.
- `public/agreement-wizard.js`: steps — kind & date → vehicle → parties →
  intermediary → money → review; purchase preselected for the purchase tab,
  intermediary skippable.
- `public/agreement.html` + `public/agreement.js`: record page mirroring `quote.html`
  (signed copy first, editable details, A4 preview, WhatsApp hand-off).
- `public/app.css`: ledger/wizard/record styles reusing existing tokens.

## 7. Docs and version

`docs/api.md` (agreement routes), `docs/template-placeholders.md` (agreement tokens),
`docs/operations.md` (migration + rollback note), `public/version.json` and the footer
labels move to **1.1.0**.

## 8. Verification

1. `npm run db:migrate:local` → 0007 applies cleanly.
2. `npm run typecheck`.
3. `wrangler dev` + curl: create/list/print/scan/status/share/export/cancel/restore/
   permanent-delete for **both** kinds; quotation paths unchanged (`/api/quotations`,
   `/s/<token>`, template studio).
4. `npm test` — the 17 scan and 5 share assertions stay green.
5. Browser walkthrough of modules → vehicle agreements → wizard → record → print.

## 9. Risks

- `templates.kind` touches six existing queries; each one is scoped explicitly and the
  studio still lists only `kind='quotation'`.
- One table for both kinds means every agreement query filters on `kind`; the number is
  unique per company so a cross-kind leak would be a 409, not silent corruption.
- Agreement share links share the scan-serving code with quotations, so the CSP and
  cache headers cannot drift between the two.
