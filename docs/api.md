# HTTP API

Base URL: `https://quote.ahmedmohamed.org`. All responses are JSON except the print sheet (HTML) and the
CSV export. Every protected route requires the `q_session` cookie set by `POST /api/setup` or
`POST /api/auth/login`.

Errors always look like `{ "error": "machine_readable_code" }` with a matching HTTP status.

## Authentication model

- One **shared passcode** per deployment, stored as PBKDF2-SHA256 (`100,000` iterations, per-record salt)
  in the `settings` table under the key `auth_passcode`.
- The session cookie is signed with HMAC-SHA256 using a key derived from the stored passcode hash:
  `hmac_key = "q_session.v1:" + hash`. Rotating the passcode therefore invalidates every existing cookie.
- Cookie format: `q_session=v1.<base64url(payload)>.<base64url(hmac)>`, `HttpOnly`, `Path=/`,
  `SameSite=Lax`, `Secure` on https, `Max-Age` from `SESSION_HOURS` (default 12).
- Payload: `{ "n": "<display name>", "exp": <unix seconds> }`. No database read is required to
  authenticate — only the single `settings` row, which is fetched per request.
- Failed logins are throttled in-isolate: 8 attempts per IP per 10 minutes (`429 too_many_attempts`).

### Public routes

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/health` | – | `{ok, service, version}` |
| `GET` | `/api/auth/status` | – | `{setup, signed_in, name, session_hours}` |
| `POST` | `/api/setup` | `{passcode, name?}` | First run only: creates the passcode, seeds a starter company + template v1, signs in. `409 already_configured` afterwards |
| `POST` | `/api/auth/login` | `{passcode, name?}` | `{signed_in, name}` + cookie. `401 invalid_passcode`, `429 too_many_attempts` |
| `POST` | `/api/auth/logout` | – | `{signed_in:false}`, clears the cookie |
| `GET` | `/api/companies/:id/logo` | – | Raw logo bytes with their stored `content-type`; `404 logo_not_found` when the company has none. Public because the print previews run in sandboxed iframes (see below) |

Passcode rules: 6–200 characters. `name` (optional, ≤60 chars) only tags the audit trail.

### Protected routes

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/auth/passcode` | `{current, next}` | `{rotated:true}` + fresh cookie for this client; all other sessions die |
| `GET` | `/api/companies` | – | `{companies:[…]}` ordered active first |
| `POST` | `/api/companies` | `{name, legal_name?, legal_name_ar?, phone?, email?, address?, quotation_prefix?, currency?}` | `201 {company}` (also creates template v1) |
| `PATCH` | `/api/companies/:id` | any of the above plus `active` | `{company}` |
| `DELETE` | `/api/companies/:id` | – | `{deactivated:true}` (soft, history is kept) |
| `GET` | `/api/companies/:id/logo` | – | see the public routes above |
| `POST` | `/api/companies/:id/logo` | `multipart/form-data`, field `file` | `201 {company, template_uses_logo}` — replaces any previous logo |
| `DELETE` | `/api/companies/:id/logo` | – | `{removed, company}` — the sheet falls back to the template's built-in mark |
| `GET` | `/api/companies/:id/templates` | – | `{templates:[{id,name,version,active,bytes,created_at}]}` |
| `POST` | `/api/companies/:id/templates` | `{html, name?, activate?}` | `201 {template}` — always a new version |
| `GET` | `/api/companies/:id/templates/:templateId` | – | `{template:{…,html}}` |
| `POST` | `/api/templates/:templateId/activate` | – | `{activated:id}` |
| `GET` | `/api/quotations?company_id=&q=&limit=` | – | `{quotations:[…], total}` (`limit` ≤ 100) |
| `GET` | `/api/quotations/next-number?company_id=&date=` | – | `{period, next_serial, quote_number, date}` — **peek only**, never advances the sequence |
| `POST` | `/api/quotations` | `{company_id, model, year, chassis, amount, quote_date?, quote_number?}` | `201 {quotation}` |
| `GET` | `/api/quotations/:id` | – | `{quotation:{…, amount, quote_date_text, currency, company}}` |
| `PATCH` | `/api/quotations/:id` | `{quote_number?, quote_date?, model?, year?, chassis?, amount?}` | `{quotation}` (amount words regenerated) |
| `DELETE` | `/api/quotations/:id` | – | `{cancelled:true}` (soft delete) |
| `GET` | `/api/quotations/:id/print` | – | A4 HTML sheet. `?print=1` adds the autoprint script |
| `GET` | `/api/export/quotations.csv?company_id=` | – | `text/csv` attachment |

### Company logo

The logo is stored in R2 (`ASSETS` binding, key `logos/<companyId>-<random>.<ext>`) and the company row
only keeps `logo_key`; `logo_url` in company payloads is the ready-to-use path.

- Accepted formats: **PNG, JPEG, WebP**. The Worker checks the file signature as well as the declared
  type, so a mislabelled or renamed file is rejected (`415 unsupported_image_type`).
- Maximum size **512 KB** (`413 logo_too_large`). SVG is deliberately refused — it is a document, not a
  raster image, and would be served from the same origin as the desk.
- Uploading a new logo deletes the previous object. `GET` is the one **public** route: the print previews
  render inside `sandbox`ed iframes whose opaque origin would drop the `SameSite=Lax` cookie, so a guarded
  read would simply 401 and print a broken image. Only the image bytes are exposed (the company UUID is
  unguessable, uploads and deletes stay authenticated), and the response carries
  `x-content-type-options: nosniff`, `content-disposition: inline` and
  `content-security-policy: default-src 'none'; sandbox`.
- `template_uses_logo` is `false` when the live template never asks for `{{logo_url}}`, i.e. the file is
  stored but cannot appear on the sheet until the template is updated (see
  [`template-placeholders.md`](template-placeholders.md#company-logo-and-watermark)).
- The printed sheet resolves the logo from the **live company profile** (like the letterhead), so a
  replaced or removed logo can never leave a broken image on a reprint.

```bash
curl -s -b jar.txt -F "file=@logo.png;type=image/png" "$BASE/api/companies/$CID/logo"
curl -s -b jar.txt -o logo.png "$BASE/api/companies/$CID/logo?v=whatever"
curl -s -b jar.txt -X DELETE "$BASE/api/companies/$CID/logo"
```

Quotation fields: `model` ≤120, `year` ≤20, `chassis` ≤120, `amount` 0–99,999,999.99 (commas and
decimals accepted), `quote_date` in `YYYY-MM-DD` (calendar-validated).

Numbering: `quotation_prefix + YYYY + "-" + 5-digit serial`, allocated atomically per company and year
through `quote_sequences`. Omitting `quote_number` allocates the next free serial; supplying one is
accepted as long as it is unique per company (`409 quotation_number_already_exists`).

### Example session

```bash
BASE=https://quote.ahmedmohamed.org
curl -s -c jar.txt -X POST "$BASE/api/setup" \
  -H 'content-type: application/json' -d '{"passcode":"team-passcode","name":"Ahmed"}'

curl -s -b jar.txt "$BASE/api/companies"
CID=$(curl -s -b jar.txt "$BASE/api/companies" | python3 -c 'import json,sys;print(json.load(sys.stdin)["companies"][0]["id"])')

curl -s -b jar.txt "$BASE/api/quotations/next-number?company_id=$CID&date=2026-11-05"

curl -s -b jar.txt -X POST "$BASE/api/quotations" -H 'content-type: application/json' \
  -d "{\"company_id\":\"$CID\",\"model\":\"AUDI A8\",\"year\":\"2012\",\"chassis\":\"WAUZZZ4H0DN000001\",\"amount\":15000,\"quote_date\":\"2026-11-05\"}"

curl -s -b jar.txt "$BASE/api/quotations/<id>/print?print=1" > sheet.html
```

## Status codes used

| Code | Meaning |
|---|---|
| `400` | Validation failure (`invalid_amount`, `invalid_quote_date`, `passcode_too_short`, …) |
| `401` | Missing/expired session, or wrong passcode |
| `404` | Unknown route or unknown record (`quotation_not_found`, …) |
| `409` | Conflict (`already_configured`, `company_slug_already_exists`, `quotation_number_already_exists`) |
| `413` | Template larger than 200,000 characters |
| `429` | Login throttled |
| `500` | Unhandled error — the Worker logs `request_failed` with path, method, message, stack head |
| `503` | `/api/health` database probe failed |
