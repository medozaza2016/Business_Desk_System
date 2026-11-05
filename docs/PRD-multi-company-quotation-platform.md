# Product Requirements Document
## Multi-Company Quotation Platform

**Product:** Challenger Quotation Platform  
**Repository:** [medozaza2016/Quotation_System](https://github.com/medozaza2016/Quotation_System)  
**Status:** In development, not production-ready  
**Document date:** 5 November 2026

## 1. Product summary

Build a secure, browser-based quotation application hosted on Cloudflare. A central administrator manages multiple companies. Each company has its own identity, quotation template, assets, currency, quotation prefix, and independent numbering sequence. Staff should be able to create, search, retrieve, and print quotations without generating PDFs on the server.

The first intended company template is for Challenger Cars. The supplied reference design must be obtained and reviewed before claiming that the implementation reproduces its exact header, footer, typography, spacing, or branding.

## 2. Problem and goals

The application should replace manually prepared quotations with a repeatable workflow that:
- Reduces manual data entry and numbering errors.
- Produces consistent, company-branded quotations.
- Preserves a searchable history of issued quotations.
- Separates each company's templates, assets, and numbering.
- Allows the central administrator to onboard and maintain companies.

### Success measures
- A quotation can be created, saved, retrieved, and printed in a supported desktop browser.
- Each company receives a unique sequential quotation number within its configured numbering period.
- Searching by quotation number, model, or chassis number returns the correct saved records.
- A quotation retains the company and template snapshot used when it was issued.
- Unauthorized users cannot access administrative or quotation data.

## 3. Users and roles

### Central administrator
- Signs in securely.
- Creates, updates, and deactivates company records.
- Configures company branding, quotation prefix, currency, and template.
- Manages company quotation history.
- Manages administrator access and, in a later phase, company-level users and roles.

### Company operator (future role)
- Works only within assigned company or companies.
- Creates and searches quotations.
- Prints saved quotations.
- Cannot change global settings or access another company's records unless explicitly authorized.

**Initial release scope:** one central administrator with multi-company management. Company-scoped staff accounts and granular roles are a subsequent release requirement, not an assumed existing capability.

## 4. Functional requirements

### FR-01 Authentication and bootstrap
- Provide administrator sign-in and sign-out.
- Store password hashes using PBKDF2-HMAC-SHA256 with a unique random salt and configured iteration count.
- Store only hashed session tokens; use secure, HttpOnly, SameSite cookies.
- Rate-limit failed login attempts.
- Permit initial administrator creation only through a one-time bootstrap process protected by a Worker secret.
- Reject subsequent bootstrap attempts once an administrator exists.
- Provide a safe password change and recovery process before production launch.
- Do not log passwords, bootstrap secrets, session tokens, or other credentials.

### FR-02 Company management
Each company record must support:
- Display name and legal name.
- Unique URL-safe slug.
- Address, phone, and email.
- Quotation prefix (default: `QA-`).
- Currency code.
- Logo, letterhead, and font asset references.
- Active/inactive status.

Deactivation must preserve historical quotations.

### FR-03 Company-specific templates
- Each company can have one active quotation template and a version history.
- Templates support documented placeholders for company and quotation fields.
- A newly created quotation stores a snapshot of the template and company details used at creation time.
- Updating a template must not alter previously issued quotations.
- Template upload and asset storage use Cloudflare R2.
- Validate uploaded template type and size. Sanitize or tightly constrain HTML and CSS. Do not allow arbitrary active content or external resource loading in templates.
- Provide preview before activating a template.

### FR-04 Quotation creation
Required quotation fields:
- Quotation date.
- Vehicle/model.
- Year.
- Chassis number.
- Estimated market value.

The system must:
- Validate required fields and monetary precision.
- Format the amount using the company's currency.
- Generate an amount-in-words statement automatically.
- Include the effective quotation date in the estimated market value statement.
- Allow authorized manual editing of the quotation number, with uniqueness validation and audit history.
- Save the quote and its snapshots in D1.

### FR-05 Numbering
- Maintain independent sequences per company and numbering period.
- Default format: `QA-YYYY-00001`, where the prefix is company-configurable and the year is based on the quotation date.
- Prevent duplicate numbers within a company.
- Sequence allocation must be concurrency-safe and transactional.
- Manual overrides must not silently corrupt the automatic sequence.

### FR-06 Quotation history and search
- List quotations for a selected company.
- Search by quotation number, model, or chassis number.
- Display date, model, year, chassis number, amount, and quotation number.
- Open a saved quotation for review and printing.
- Support soft deletion or cancellation with an audit trail, rather than destructive deletion.

### FR-07 Print
- Render the saved quotation as HTML.
- Invoke the browser's native print dialog.
- Support A4 print layout and responsive screen preview.
- Do not generate PDFs on the server.
- Ensure print output excludes application controls and preserves the stored quotation snapshot.

## 5. Non-functional requirements

### Security
- Enforce authentication and authorization on every protected API route.
- Scope every company-owned read and write by server-validated company permissions.
- Apply CSRF protections to cookie-authenticated state-changing requests.
- Apply rate limits to authentication and sensitive endpoints.
- Use parameterized SQL statements.
- Escape all user-provided values in rendered HTML.
- Apply a restrictive Content Security Policy and avoid untrusted scripts in templates.
- Keep secrets in Cloudflare Worker secrets, never in source control or client code.
- Maintain audit events for administrative changes and quotation number overrides.

### Reliability and data integrity
- Use D1 transactions/batches for sequence allocation and related writes.
- Add database constraints and indexes for common lookup paths.
- Handle duplicate numbers and concurrent submissions deterministically.
- Back up and test restoration of D1 data before production.

### Performance and compatibility
- Keep common API requests responsive under normal business usage.
- Support current desktop versions of Chrome, Edge, Safari, and Firefox.
- Ensure quotations remain readable on mobile screens, while optimizing print for A4.

### Maintainability
- Document environment bindings, migrations, bootstrap, deployment, and rollback.
- Keep HTML templates versioned and independently reviewable.
- Add automated tests for authentication, authorization, numbering, search, and print rendering.

## 6. Proposed technical architecture

| Layer | Cloudflare service | Responsibility |
|---|---|---|
| Application/API | Workers | HTML application, API routes, authentication, business rules |
| Relational data | D1 | Admins, companies, templates, sequences, quotations, sessions, audit events |
| Binary assets | R2 | Logos, letterheads, fonts, approved template assets |
| Source control | GitHub | Application source, migrations, PRD, default template, CI |

### Core data entities
- `admin_users`
- `sessions`
- `companies`
- `templates`
- `quote_sequences`
- `quotations`
- `login_attempts`
- `audit_events` (to be added)

## 7. Current implementation baseline

The repository currently contains an initial Worker application with:
- Administrator login and a protected first-admin setup endpoint.
- D1-backed company records.
- Template version storage endpoints.
- Quotation create/list/detail/print API routes.
- Company/year sequence allocation logic.
- A basic default HTML quotation template.
- D1 and R2 binding configuration.

Known gaps and caveats:
- Initial administrator bootstrap has returned HTTP 500 in the configured custom domain flow. The cause has not yet been identified. Do not assume the administrator was created.
- The live Cloudflare log stream failed to establish a WebSocket connection, so the exception remains undiagnosed.
- The current browser interface is not yet a complete quotation workflow UI.
- Company-level users, role-based access, password change/recovery, asset upload management, and audit history are not complete.
- Template HTML safety and a production-grade template editor/preview need review.
- The default template is a starter layout, not a verified reproduction of the original Challenger Cars quotation artwork.
- Automated test coverage and production operational checks remain incomplete.

## 8. Acceptance criteria for initial usable release

1. First administrator can be created exactly once through the protected bootstrap process.
2. Administrator can sign in and sign out successfully.
3. Administrator can create and deactivate companies.
4. Each company can activate a template and retain prior template versions.
5. Two companies can issue quotations with independent numbering sequences.
6. Concurrent quotation creation does not produce duplicate automatic numbers.
7. A quotation can be saved and retrieved after refresh or a new session.
8. Search works by quote number, model, and chassis number.
9. Print output uses the saved template and company snapshot.
10. Unauthorized requests are rejected, and one company cannot access another company's records through the API.
11. D1 backup/restore and deployment rollback procedures are documented and tested.

## 9. Delivery plan

### Phase 0: Stabilize bootstrap and deployment
- Diagnose the HTTP 500 from `POST /api/setup`.
- Verify the Worker has the D1 binding and the required schema.
- Verify the `BOOTSTRAP_SECRET` binding is present in the deployed environment.
- Create the first administrator and verify login.
- Add a password change flow and remove or permanently disable bootstrap after successful setup.

### Phase 1: Complete core administration
- Finish company CRUD and company selection.
- Add template upload, validation, preview, activation, and version history.
- Add R2 asset management.

### Phase 2: Complete quotation workflow
- Build the quotation creation form.
- Build quotation history and search UI.
- Add edit/cancel policy, audit events, and robust numbering tests.
- Verify amount-in-words and currency handling for supported currencies.

### Phase 3: Brand fidelity and print quality
- Obtain the approved Challenger Cars source quotation/template.
- Match fonts, header, footer, logo, spacing, table, and print margins.
- Validate output against reference print samples.

### Phase 4: Production hardening
- Add automated unit/integration tests and CI.
- Complete authorization, CSRF, CSP, input validation, and rate-limit review.
- Test backup/restore, monitoring, alerting, and rollback.
- Run acceptance tests on supported browsers.

## 10. Out of scope for initial release
- Server-side PDF generation.
- Payment collection and invoicing.
- Accounting/ERP integrations.
- Customer self-service portal.
- E-signatures.
- Automated valuation feeds or vehicle-market integrations.

## 11. Open decisions
- Which currencies and locale-specific amount-in-words rules are required?
- Is the numbering period always annual, or configurable by company?
- Should quotations be editable after issue, or only cancelled and reissued?
- Which company users can approve manual quotation number overrides?
- What is the approved original Challenger Cars template and font package?
- What retention and backup policy applies to quotations and audit events?

## 12. Production readiness statement

**Not production-ready.** Administrator bootstrap is currently blocked by an unresolved HTTP 500. Do not use the application for live business quotations until bootstrap, authentication, authorization isolation, data integrity, template security, backups, and acceptance tests have been verified.


## 13. Supplied Challenger Cars design reference and template delivery

A visual reference for the bilingual Challenger Cars quotation was supplied on 5 November 2026. The repository template `templates/default-quotation.html` has since been rebuilt as a full-page A4 portrait document based on that reference.

The delivered layout includes:
- Brand header with the supplied winged-C logo crop embedded directly in the HTML.
- Arabic and English company headings and bilingual quotation title.
- Quotation number and date fields.
- Preliminary valuation introduction in Arabic and English.
- Vehicle model, year, and chassis detail rows.
- Estimated value field and bilingual value statement.
- Notes, signature and stamp boxes.
- Company contact footer and bottom brand stripe.

The template uses the application's existing replacement fields, including `quote_number`, `quote_date`, `model`, `year`, `chassis`, `currency`, `amount`, `amount_words`, `company_phone`, `company_email`, and `company_address`. The HTML is self-contained and does not require an external letterhead URL. The Worker formats quotation dates before template rendering and owns the print-dialog invocation, so the HTML template intentionally contains no inline JavaScript.

**Visual QA still required:** compare browser print output against the supplied image on A4 paper, especially Arabic font rendering, line wrapping, and printer margins. The supplied screenshot is a visual reference, not an original editable design file. The template should not be described as pixel-perfect until this print comparison is completed.

**Integration status:** the template is committed to GitHub, but it has not yet been activated as a versioned template record for a company in D1. Administrator bootstrap remains unresolved, so application-level activation and print validation are pending.
