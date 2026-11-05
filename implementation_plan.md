# Implementation Plan v2 — simple shared-passcode auth + "Precision paperwork" UI

Status: **in progress** (Act mode). Repo: `/home/ahmed/GitHub/Quotation_System`.

## [Overview]

Port the `docs/` Jinja reference UI (workspace, record page, bilingual A4 print sheet) onto the existing
Cloudflare Worker + D1 app, fixing verified blocking bugs, and **reduce** runtime complexity by replacing
the admin-account/bootstrap subsystem with a shared-passcode + stateless signed-session model.

1. **Auth simplification.** One shared passcode (set in-app on first run, rotatable in-app). The session is
   an HMAC-signed cookie — no `sessions` table, no per-request DB read. Deleted: `admin_users`, `sessions`,
   `login_attempts`, `BOOTSTRAP_SECRET` and the secret-header bootstrap. The optional display name typed at
   login is used only to attribute audit rows.
2. **UI optimisation using the `frontend-design` skill.** Direction *"precision paperwork"*: warm paper
   background, ink text, one brand-red accent, hairline geometry, tabular numerals, mono for machine data,
   asymmetric two-column workspace, live A4 preview inside the record page. No web fonts, no framework, no
   build step — the printed sheet stays faithful to the reference.

### Verified bugs this plan fixes

| # | Bug | Evidence | Fix |
|---|-----|----------|-----|
| 1 | `renderQuote` regex never matches | `src/index.js:35` uses `/\\{\\{([a-z_]+)\\}\\}/g` (literal backslashes) | `/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g` + `escapeHtml` |
| 2 | Date validation rejects every real date | `src/index.js:121` wraps the regex literal in `test()` | plain `/^\d{4}-\d{2}-\d{2}$/` + round-trip check |
| 3 | Print CSP blocks the letterhead, no script hash | `src/index.js:148` | `img-src`/`font-src` + `sha256-…` of the single autoprint script |
| 4 | `Secure` cookie breaks local http | `src/index.js:65` | `Secure` only when the request URL is https |
| 5 | `POST /api/setup` 500 | live: 0 admin rows, schema applied, PBKDF2 210,000 > workerd cap 100,000 | fixed 100,000 iterations, surfaced via `console.error` |
| 6 | Static assets unreachable on the live Worker | live `has_assets:false` | deploy with `[assets]`; shell lives in `public/` |

### Cloudflare objects (MCP-verified, account `4ed0b7cda99d43ce679d2aace4d3f525`)

| Object | Current | Act-mode action |
|---|---|---|
| Worker `challenger-quotation-platform` | deployed, `has_assets:false`, observability off | `wrangler deploy`, `[observability] enabled = true` |
| D1 `challenger-quotation-db` (`f8919c6e-…`) | 8 tables, 0 rows | migration `0002` → 5 tables |
| R2 `challenger-quotation-assets` | empty, bound | keep binding, unused this phase |
| Secret `BOOTSTRAP_SECRET` | present | delete |
| Custom domain `quote.ahmedmohamed.org` | attached | untouched |

No new Cloudflare objects are required; the work is configuration + code + one migration.

## [Types]

JSDoc typedefs, `checkJs` via a new `tsconfig.json`.

```js
/** @typedef {{ id:string, name:string, slug:string, legal_name:string, phone:string, email:string,
 *              address:string, quotation_prefix:string, currency:string, font_name:string,
 *              active:number, created_at:string }} CompanyRow */
/** @typedef {{ id:string, company_id:string, name:string, version:number, html:string,
 *              active:number, created_at:string }} TemplateRow */
/** @typedef {{ id:string, company_id:string, template_id:string|null, quote_number:string,
 *              quote_date:string, model:string, year:string, chassis:string, amount_cents:number,
 *              amount_words:string, template_html_snapshot:string, company_snapshot_json:string,
 *              created_at:string }} QuotationRow */
/** @typedef {{ salt:string, hash:string, iterations:number, updated_at:string }} AuthRecord */
/** @typedef {{ name:string, exp:number }} SessionClaims */
/** @typedef {{ actor:string, action:string, entity:string, entity_id:string|null,
 *              details:Record<string, unknown> }} AuditEvent */
```

Schema after `migrations/0002_simple_auth.sql`: `companies`, `templates`, `quote_sequences`,
`quotations`, `settings`, `audit_events` (the three auth tables are dropped; they are empty).
