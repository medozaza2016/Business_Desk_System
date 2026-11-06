# Challenger Quotation Platform

Multi-company quotation desk for Challenger Cars: issue bilingual (English/Arabic) A4 valuation
quotations, keep an immutable record of every sheet, and print or save to PDF from the browser.

Live: <https://desk.luxoritpro.com>

## Stack

- **Cloudflare Workers** — API, print rendering, all routing
- **Workers Assets** (`./public`) — the desk UI, no framework, no build step
- **D1** — `companies`, `templates`, `quote_sequences`, `quotations`, `quotation_scans`, `settings`, `audit_events`
- **R2** (`ASSETS`) — per-company logos (`logos/…`) and signed pages (`scans/…`), validated PNG/JPEG/WebP,
  plus PDF for a signed page
- Authentication: one shared passcode, PBKDF2-SHA256 (100,000 iterations), stateless HMAC session cookie

## Features

- Vehicle valuation entry with automatic numbering (`QA-2026-00001`, per company and per year) and a
  read-only number preview that never burns a serial.
- Optional free-form comment per quotation (`{{comments}}`, ≤300 chars): typed on the entry rail, still
  editable on the record page, and carried into the CSV export.
- Company switcher in the header; every quotation is scoped to its company.
- Per-company logo uploaded from the company profile and printed twice: as the header mark and as a
  faint watermark on the A4 sheet (`{{logo_url}}` / `{{logo_state}}`).
- Bilingual A4 print sheet positioned in millimetres over a letterhead background, printed by the
  browser (Save as PDF) — no PDF service, no stored binaries.
- Versioned HTML templates per company; the issued sheet is a snapshot, so later edits never rewrite
  history.
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
public/index.html                 Desk: passcode gate, workspace, settings
public/quote.html                 Quotation record + signed copy + live A4 preview
public/app.css                    Design system ("precision paperwork")
public/app.js, public/quote.js    Client logic
public/scan.js                    In-app scanner: detection maths + camera shell
scripts/test-scan.mjs             Node unit tests for the scan geometry
migrations/                       D1 schema, forward-only
docs/                             API, templates, operations, PRD
```

## Tests

```bash
npm run test:scan            # scanner geometry (detect, homography, warp, lighting)
npm run test:share           # the three shapes of the public share page
npm test                     # both
npm run typecheck            # tsc over the Worker and the client modules
```

## Notes

- `public/letterhead_background.png` is a white placeholder until the real artwork is supplied.
- A company logo only prints where its template asks for `{{logo_url}}`; templates published before the
  logo feature must add that block (see `docs/template-placeholders.md`). The desk warns you when the
  live template has no slot for the upload.
- Amount in words is generated in English; the Arabic sentence on the sheet carries the figure.
- Do not expose D1 or R2 credentials to the client; every query is scoped server-side.
