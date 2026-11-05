# Challenger Quotation Platform

A Cloudflare-native multi-company quotation application.

## Stack
- Cloudflare Workers for the API and static application
- D1 for users, companies, templates, sequences, and quotation history
- R2 for company logos, letterheads, and font assets
- HTML quotation rendering with browser-based printing

## Initial deployment
1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Configure the D1 database binding and R2 bucket binding in `wrangler.toml`.
4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` as Worker secrets. Password hash format and bootstrap procedure will be documented with the authentication implementation.
5. Run `npm run db:migrate:remote`.
6. Run `npm run deploy`.

Do not expose D1 or R2 credentials in client-side code. Every company-owned query must be scoped server-side to the authenticated company.

## Current stage
Initial application foundation. Authentication, company administration, quotation workflows, template editing, and production hardening are being implemented incrementally.
