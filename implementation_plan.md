# Implementation plan — signed copy, WhatsApp hand-off, ledger order, completion

Status: **implemented**. This file records the plan that was approved before any code was written,
so the decisions and their reasons stay next to the code.

## Goal

1. Store the **signed quotation** (the page the customer signed) against its record, captured with an
   in-app scanner — no third-party SDK, no build step.
2. A **WhatsApp send step**: the desk's default is either *attach the signed file* or *send a private
   link*, switchable per send.
3. **Sort the ledger by quotation number** (highest first), with `?sort=date` for the calendar order.
4. **Mark a record completed** from the list and from the record page.
5. **Redesign the record page** so the signed paper is the first thing on it.

## Confirmed decisions

| Question | Decision | Why |
|---|---|---|
| How does a customer receive the paperwork? | Public tokenised page `/s/<token>` | WhatsApp links carry text only; a `wa.me` message can never include a file. The share sheet (mobile) does attach the file — so both paths exist, the page is the fallback and the *link* mode. |
| What does "completed" mean? | Frozen: `PATCH`/`DELETE` refuse, reopening is explicit | The stamp on the paper claims the record is filed; letting the numbers drift afterwards would make the stamp a lie. |
| Can a record be completed without a scan? | No — `409 scan_required` | A completed record with no signed page is exactly the case the feature exists to prevent. |
| Where does the file/link choice live? | `settings.quotation_share_mode`, default `file` | One desk-wide default, overridden per send on the record page; no per-user state, matching the shared-passcode model. |
| Do scans survive a cancelled record? | Yes (soft delete keeps them) | Recovering a cancelled quotation restores the whole record, paperwork included. |

## Schema

- `migrations/0005_quotation_scans.sql` — `quotation_scans` keyed by `quotation_id` (one page per record;
  a re-scan replaces it): `company_id, r2_key, content_type, bytes, width, height, source, created_at`.
- `migrations/0006_quotation_workflow.sql` — `quotations.status` (`issued`/`completed`),
  `completed_at`, `share_token`, `share_token_created_at`, plus a unique index on the token.
  "Signed" is **derived** from the scan row, never stored, so the two cannot disagree.

## Worker (`src/index.js`, `src/share-page.js`)

- `IMAGE_TYPES` / `sniffImageType` shared by the logo and scan routes (signature check, not just the
  declared content type).
- Scan routes: `GET/POST/DELETE /api/quotations/:id/scan` (image ≤ 4 MB, PDF ≤ 12 MB, R2 under
  `scans/<company>/…`, previous object deleted on replace, `etag` from the key suffix so a
  re-scan busts caches). `SCAN_TYPES` is the logo’s `IMAGE_TYPES` plus `PDF_TYPE` (`%PDF`),
  checked by signature rather than by the declared content type.
- Workflow: `PATCH /api/quotations/:id/status`; `PATCH`/`DELETE` on a completed record return
  `409 quotation_completed`.
- Share link: `POST`/`DELETE /api/quotations/:id/share-link` — minted with the first scan, rotatable,
  revocable. The raw token never leaves the Worker (payloads carry `share_path` only).
- Public: `GET /s/<token>` (`src/share-page.js`, one inline-styled HTML document with `og:` tags,
  `noindex`, `no-referrer`, tight CSP) and `/s/<token>/scan`. The page’s Print button is the only
  script, pinned by CSP hash (`SHARE_PRINT_SCRIPT`); the old `/s/<token>/sheet` route is gone —
  a picture signed copy is printed by the page itself. A PDF signed copy gets a plain link instead of
  the script (`Print the PDF` → `/s/<token>/scan`, inline), because `window.print()` prints the HTML
  in front of it and would leave the signed page out.
- Settings: `GET`/`PATCH /api/settings` with `share_mode ∈ {file, link}`.
- Ledger: `ORDER BY q.quote_number DESC` by default, `?sort=date` for the old order; the scan is joined
  once per page so `has_scan` needs no second round-trip. CSV follows the number order.

## Client

- `public/scan.js` — the scanner. Maths (`toGray`, `boxBlur`, `otsuThreshold`, `quadFromMask`,
  `orderQuad`, `detectQuad`, `solveHomography`, `warpPage`, `flattenLighting`) is pure and unit-tested in
  Node (`scripts/test-scan.mjs`); the camera shell streams the back camera at 8 fps detection on a 320 px
  thumbnail, freezes the frame for corner dragging, then warps + flattens + JPEG-encodes at 1600 px.
  No camera or no permission falls back to the phone's own picker, which runs the same warp.
  `flattenLighting` is per channel, so a tungsten lamp no longer tints the paper yellow; `paperTone`
  then applies the finish the operator picked: **Colour** (white paper, pen and stamp in colour) or
  **Grey & white** (a plain photocopy). The control bar sits **above** the camera frame, because on a
  phone the bottom of the screen belongs to the browser.
- `public/quote.js` + `quote.html` — the signed copy is the first card: picture with crop marks, mono
  measurements, send controls, completion stamp. The edit form freezes when completed.
  Three ways in share one route: *Scan the signed page*, *Upload a photo* (the same correction without
  the camera) and *Upload a PDF*; a PDF replaces the picture with a document tile.
- `public/app.js` + `index.html` — ledger sort switch, state chip per row, Complete/Reopen action,
  and a *WhatsApp hand-off* settings pane.
- `public/app.css` — signed card, segmented switch, scanner surface, settings choice list; responsive at
  1180 / 980 / 760 / 640 / 480.

## Verification performed

- `npm run test:scan` — 17 geometry tests (detection, ordering, homography, warp, lighting, the two
  finishes).
- `npm run test:share` — 5 render tests: a picture page prints itself, a PDF page hands the printing to
  the file, a quotation without a signed copy says so, one hashed script per page.
- `npm run typecheck` — Worker + client.
- Backend smoke over a scratch D1 (`--persist-to /tmp/qtest`): setup → create → list order/flags →
  scan upload (accept PNG, reject text) → byte serving with/without `download` → share page, scan, sheet,
  junk token → completion guard, frozen patch, reopen → settings validation → link rotate/revoke →
  scan delete → CSV.
- Browser (Playwright, fake camera, 1280 / 768 / 390): gate → desk (chips, sort, no sideways scroll) →
  record → live scan → review → corner drag → upload → complete (stamp, frozen form) → share link copied
  and opened → WhatsApp fallback downloads the JPEG and opens the chat → print sheet renders.
- Known pre-existing finding, untouched: the default print template links Google Fonts, which the sheet's
  CSP blocks (`style-src 'unsafe-inline'`). Allowing remote CSS would weaken the sheet's lockdown, so the
  fix belongs in a separate decision (self-host the Arabic faces, or drop the link).
