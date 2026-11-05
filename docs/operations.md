# Operations

## What runs where

| Piece | Resource | Notes |
|---|---|---|
| Worker | `challenger-quotation-platform` | API + print rendering, custom domain `quote.ahmedmohamed.org` |
| Static UI | Workers Assets (`env.STATIC`, `./public`) | `index.html`, `quote.html`, `app.css`, `app.js`, `quote.js`, letterhead |
| Database | D1 `challenger-quotation-db` (`f8919c6e-a35e-4aa7-8178-dfb11e9303cf`) | 6 tables: `companies`, `templates`, `quote_sequences`, `quotations`, `settings`, `audit_events` |
| Objects | R2 `challenger-quotation-assets` (`env.ASSETS`) | Reserved for per-company artwork; unused in this phase |
| Secrets | none | The shared passcode lives in D1, not in Worker secrets |

`[observability] enabled = true` is set in `wrangler.toml`, so `console.*` output and request logs are
visible in **Workers → challenger-quotation-platform → Logs**.

## Routine commands

```bash
npm install                       # once per machine
npm run dev                       # local Worker on http://127.0.0.1:8787
npm run db:migrate:local          # apply pending migrations to the local D1 copy
npm run typecheck                 # src (Workers types) + public (DOM types)
npm run deploy                    # upload Worker + assets
npm run db:migrate:remote         # apply pending migrations to production D1
```

`npm run db:migrate:remote` prompts for confirmation; in a non-interactive shell wrangler takes the
default answer, which is "yes".

## First-run procedure

1. Open `https://quote.ahmedmohamed.org`.
2. The desk asks for a passcode because `POST /api/setup` has never been called (`setup:false`).
3. Enter the shared passcode (6+ characters). This:
   - stores `PBKDF2-SHA256(passcode, salt, 100000)` in `settings.auth_passcode`,
   - seeds company **Challenger Cars** with template v1,
   - signs you in and drops the signed cookie.
4. Open **Settings** and fill in the real company name, legal name, phone, email, address, prefix and
   currency — those values are frozen into every quotation issued afterwards.

The setup endpoint refuses to run once a passcode exists (`409 already_configured`), so the deployment
cannot be claimed twice.

## Passcode handling

- **Rotate:** Settings → *Shared access* → current + new passcode. Rotation re-salts and re-hashes the
  passcode, which changes the session signing key: every other device is signed out immediately, and the
  device that performed the rotation receives a fresh cookie.
- **Forgot it:** there is no email reset. Overwrite the row and sign in again:

  ```bash
  npx wrangler d1 execute challenger-quotation-db --remote \
    --command "DELETE FROM settings WHERE key='auth_passcode'"
  ```

  The next visit shows the first-run setup screen again — all companies and quotations are untouched.

## Quarterly / ad-hoc maintenance

```bash
# row counts
npx wrangler d1 execute challenger-quotation-db --remote \
  --command "SELECT (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM quotations) AS quotations"

# recent audit trail
npx wrangler d1 execute challenger-quotation-db --remote \
  --command "SELECT created_at, actor, action, entity_id FROM audit_events ORDER BY created_at DESC LIMIT 20"
```

`audit_events` records `auth.setup`, `auth.passcode_rotated`, `company.created`, `company.updated`,
`company.deactivated`, `template.saved`, `template.activated`, `quotation.created`, `quotation.updated`
and `quotation.cancelled`. Writes are fire-and-forget through `ctx.waitUntil`, so a failed audit insert
never fails a request. `actor` is `Shared user` for every browser session, because the desk collects
only the passcode; `POST /api/setup` and `POST /api/auth/login` still accept an optional `name`, so
scripted changes can be attributed.

## Letterhead artwork

`public/letterhead_background.png` is currently a 1×1 white placeholder, which renders as a clean white
A4 sheet. Replace it with the real artwork (A4 @ 150–300 dpi, header/footer already composed), then
`npm run deploy`. See `docs/template-placeholders.md` for the print geometry.

## Print behaviour

- The record page embeds `/api/quotations/:id/print` in an iframe and scales it to fit; no PDF is stored.
- *Print / PDF* opens `…/print?print=1`, which appends a four-line autoprint script and allows exactly
  that script via a `sha256` CSP hash. Browser → *Save as PDF* is the export path.
- Company templates can never execute JavaScript: `script-src` allows only the Worker's hash.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `internal_error` on setup | PBKDF2 iterations above 100,000 (workerd cap) or the `settings` table missing | check `npm run db:migrate:remote`, then Logs for `request_failed` |
| Login works, next request is `401` | cookie not sent (different host, or `Secure` on plain http) | use https in production; `wrangler dev` over http omits `Secure` automatically |
| Sheet shows `{{placeholder}}` text | a template version imported from the old Jinja files | republish through Settings → *Print template* |
| Sheet has no letterhead | `letterhead_background.png` missing or the template's CSS was edited | redeploy `public/`, keep `url("{{letterhead_url}}")` |
| `has_assets:false` after a deploy | deployed before `public/` existed | run `npm run deploy` again — assets are uploaded with the Worker |
| Print preview blocked | the page is embedded in another origin | `frame-ancestors 'self'` — open the desk on its own domain |

## Recovery

- Quotations are soft-deleted (`deleted_at`); restore with
  `UPDATE quotations SET deleted_at=NULL WHERE quote_number='…'`.
- Companies are soft-deactivated (`active=0`); re-activate with
  `UPDATE companies SET active=1 WHERE id='…'`.
- Template versions are append-only. Publishing a new version never destroys history, and any earlier
  version can be re-activated.
