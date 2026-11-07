# Challenger Quotation Platform

Multi-company quotation desk for Challenger Cars: issue bilingual (English/Arabic) A4 valuation
quotations, keep an immutable record of every sheet, and print or save to PDF from the browser.

Live: <https://desk.luxoritpro.com>

## Stack

- **Cloudflare Workers** — API, print rendering, all routing
- **Workers Assets** (`./public`) — the desk UI, no framework, no build step
- **D1** — `companies`, `templates`, `quote_sequences`, `quotations`, `quotation_scans`, `agreements`,
  `agreement_scans`, `agreement_sequences`, `settings`, `audit_events`
- **R2** (`ASSETS`) — per-company logos (`logos/…`) and signed pages (`scans/<company>/…`, agreements under
  `scans/agreements/<company>/…`), validated PNG/JPEG/WebP, plus PDF for a signed page
- Authentication: one shared passcode, PBKDF2-SHA256 (100,000 iterations), stateless HMAC session cookie

## Features

- Vehicle valuation entry with automatic numbering (`QA-2026-00001`, per company and per year) and a
  read-only number preview that never burns a serial. The quotation book is the same page as the
  agreement book — a stamped header, one toolbar, the table, a strip of mono facts — and the new
  sheet is asked for in a dialog, opened from **New quotation** (or `n`).
- Optional free-form comment per quotation (`{{comments}}`, ≤300 chars): typed in the new-quotation
  dialog, still editable on the record page, and carried into the CSV export.
- Company switcher in the header; every quotation is scoped to its company.
- Per-company logo uploaded from the company profile and printed twice: as the header mark and as a
  faint watermark on the A4 sheet (`{{logo_url}}` / `{{logo_state}}`).
- Bilingual A4 print sheet positioned in millimetres over a letterhead background, printed by the
  browser (Save as PDF) — no PDF service, no stored binaries.
- Versioned HTML templates per company; the issued sheet is a snapshot, so later edits never rewrite
  history. The template studio is one frame with two tabs — the rendered A4 proof (the default) and the
  HTML behind it — so a redesign is checked on the paper without leaving the page.
- Live A4 preview inside the quotation record page, editable details, soft cancel, per-company CSV
  export, and an audit trail of every mutation.
- **Signed copy per quotation**, captured with an in-app scanner: the page outline is detected live, the
  four corners stay draggable, and the stored image is a straightened JPEG whose paper is white — the
  scanner divides out the lamp's colour, so an indoor photo is not left yellow, and the operator can pick
  **Colour** or **Grey & white**. A photo already on the phone or a scanner's **PDF** can be uploaded
  instead (≤ 12 MB), through the same card. No SDK, no build step — the geometry runs in the browser
  (`public/scan.js`).
- **WhatsApp hand-off** from the record page: attach the signed file through the OS share sheet, or send
  a private `/s/<token>` link with the figures and the same page. The desk default lives in *Settings*
  and the operator can switch it for a single send. On a desktop the picture downloads and the caption is
  copied, because `wa.me` links cannot carry a file. The `/s/` page is public by design — no sign-in, no
  cookie — and prints itself, so the customer can keep a paper copy without a second tab.
- **Workflow state**: a quotation is *issued* → *signed* (a scan exists) → *completed*. Completing needs
  the signed page, freezes the numbers, and stamps the record; reopening thaws it.
- The ledger is ordered by quotation number (highest first) with `?sort=date` for the calendar order, and
  each row shows whether the paperwork is unsigned, signed or completed. A row carries no buttons: the
  whole line opens the record (the number inside stays a real link, so the keyboard keeps its own route),
  and print, complete and cancel live on that record page.
- **Vehicle sale and purchase agreements** — a second book beside the quotations, with its own numbering
  (`SA-2026-00001` / `PA-2026-00001`, one counter per company, kind and year), its own per-kind templates
  and placeholders, and a six-step wizard (paper → vehicle → parties → money → terms → issue) that
  previews the sheet before it is issued. The record page (`/agreement?id=…`) edits the details, files the
  signed page through the same scanner, prints the A4 sheet, hands the paperwork to WhatsApp as a file or
  as a private `/a/<token>` link, and shows that record's audit trail. Both books share the ledger
  machinery: search, cancelled view, restore, permanent delete with the number typed back, and the same
  *issued → completed* workflow. Neither ledger carries export or print buttons; both books still write a
  CSV at `/api/export/quotations.csv` (also linked from the company pane in *Settings*) and
  `/api/export/agreements.csv`.

## Quick start

```bash
npm install
npm run db:migrate:local     # apply migrations to the local D1 copy
npm run dev                  # http://127.0.0.1:8787
```

The first visit asks for a shared passcode; that creates company **Challenger Cars** and the default
template. Fill in the real company details under *Settings*.

## Deploy

```bash
npm run db:migrate:remote
npm run deploy
```

The Worker name, D1 id, R2 bucket and asset directory live in `wrangler.toml`; `SESSION_HOURS` is a plain
variable there. No Worker secrets are required.

## Documentation

| Document | Contents |
|---|---|
| [`docs/api.md`](docs/api.md) | Full HTTP API, auth model, status codes, curl examples |
| [`docs/template-placeholders.md`](docs/template-placeholders.md) | Print template tokens, CSP rules, letterhead geometry |
| [`docs/operations.md`](docs/operations.md) | First run, passcode rotation and recovery, audit queries, troubleshooting |
| [`docs/PRD-multi-company-quotation-platform.md`](docs/PRD-multi-company-quotation-platform.md) | Product requirements |

`docs/index.html`, `docs/detail.html` and `docs/quotation.html` are the original Jinja reference screens,
kept for visual comparison. They are not served by the Worker.

## Project layout

```
src/index.js                      Worker: auth, API, print rendering, scan + share routes
src/share-page.js                 The public /s/<token> page (one HTML document)
src/types.d.ts                    *.html text-module declaration
templates/default-quotation.html  Bilingual A4 sheet (seeded as template v1)
templates/default-sales-agreement.html, default-purchase-agreement.html
                                  Built-in agreement sheets (snapshotted when a company has published none)
public/index.html                 Desk: passcode gate, workspace, settings, agreement wizard
public/quote.html                 Quotation record + signed copy + live A4 preview
public/agreement.html             Agreement record + signed copy + print preview + audit
public/app.css                    Design system ("precision paperwork")
public/app.js, public/quote.js    Client logic
public/agreement.js, public/agreement-wizard.js
                                  Agreement record and its six-step wizard
public/version.js                 The one build-label loader every page footer uses
public/scan.js                    In-app scanner: detection maths + camera shell
public/dialog.js                  The confirm dialog (typed confirmation for deletes)
public/globals.d.ts               Ambient browser globals (Turnstile) for the typecheck
scripts/test-scan.mjs             Node unit tests for the scan geometry
scripts/test-share.mjs            Node unit tests for the public share page
scripts/test-agreement-share.mjs  Node unit tests for the public agreement page
migrations/                       D1 schema, forward-only
docs/                             API, templates, operations, PRD
```

## Tests

```bash
npm run test:scan            # scanner geometry (detect, homography, warp, lighting)
npm run test:share           # the three shapes of the public share page
npm run test:agreement-share # the public agreement page: picture, PDF, no signed copy
npm test                     # all three
npm run typecheck            # tsc over the Worker and the client modules
```

## Notes

- `public/letterhead_background.png` is a white placeholder until the real artwork is supplied.
- A company logo only prints where its template asks for `{{logo_url}}`; templates published before the
  logo feature must add that block (see `docs/template-placeholders.md`). The desk warns you when the
  live template has no slot for the upload.
- Amount in words is generated in English; the Arabic sentence on the sheet carries the figure.
- Do not expose D1 or R2 credentials to the client; every query is scoped server-side.
