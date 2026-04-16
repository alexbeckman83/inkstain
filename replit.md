# Inkstain — replit.md

## Overview

Inkstain is an AI provenance platform for authors. It helps writers prove the authenticity of their manuscripts by capturing a tamper-evident record of how their work was created — tracking AI tool usage, app-switching patterns, and edit timing without ever reading the manuscript content itself.

The platform serves three audiences:
- **Authors** — who install a desktop Trail app, upload their manuscript + Trail data, and receive a signed PDF certificate of authorship
- **Publishers & Newsrooms** — who get a dashboard to manage contributor certificates and verify submissions
- **Institutions** — universities and agencies who need AI disclosure compliance across many users

The core product generates cryptographic certificate hashes from document metadata (not content), making certificates verifiable by anyone with the hash.

---

## User Preferences

Preferred communication style: Simple, everyday language.

---

## System Architecture

### Backend
- **Runtime**: Node.js (≥18) running `server.js` as a monolithic HTTP server using the built-in `http` module — no Express or framework
- **Routing**: Manual pathname matching inside the request handler (`if (pathname === '...')`)
- **Certificate Generation**: Python 3 script (`certificate.py`) invoked as a child process via `spawn()` from Node — uses `python-docx` to read Word document metadata and `reportlab` to produce PDF certificates
- **Database**: PostgreSQL via the `pg` npm package, connected through `DATABASE_URL` environment variable. Tables include: `accounts`, `publishers`, `certificates`, `waitlist`
- **File Uploads**: Temporarily written to OS temp directory (`os.tmpdir()/inkstain-uploads`) before being processed by the Python script
- **Admin Sessions**: In-memory `Map` (not persisted) with 24-hour expiry — admin tokens are lost on server restart
- **Auth for authors/publishers**: Session tokens stored in the database, passed as Bearer tokens in `Authorization` header or stored in `localStorage` on the client

### Frontend
- **Architecture**: Plain HTML files served as static files — no frontend framework, no build step
- **Pages**: `index.html` (landing), `trail.html` (generate certificate), `verify.html` (verify a certificate), `join.html` (author signup), `signin.html`, `account.html`, `publishers.html`, `publishers-signup.html`, `publishers-login.html`, `publishers-dashboard.html`, `publishers-forgot-password.html`, `publishers-reset-password.html`, `dashboard.html`, `admin.html`, `admin-dashboard.html`
- **Design System**: Consistent CSS custom properties across all pages — ink `#1B2A3B`, parchment `#f5f2eb`, amber `#c8956b`. Fonts: Playfair Display (headings) + EB Garamond (body) from Google Fonts
- **JS**: Inline `<script>` tags in each HTML page, calling `/api/*` endpoints with `fetch()`

### Key Data Flows

1. **Certificate Generation**: Author uploads `.docx` + Trail JSON → Node writes temp files → spawns Python process → Python reads Word metadata (never content) → generates PDF → Node streams PDF back → hash stored in `certificates` DB table
2. **Verification**: Anyone submits a certificate hash → `/api/verify` looks up hash in DB → returns certificate metadata
3. **Publisher Auth**: Signup → password hashed (SHA-256) → stored in DB → login generates random session token → stored in DB → client stores token in `localStorage`
4. **Admin**: Password compared to `ADMIN_PASSWORD` env var → session cookie set → all `/admin/*` routes check cookie

### Security Notes
- Password hashing uses SHA-256 (not bcrypt) — this is a known weakness if upgrading security is needed
- Admin sessions are in-memory only (lost on restart)
- SQL queries should use parameterized queries (`$1`, `$2`) — verify all DB calls follow this pattern

### Stripe Integration
- `stripe` npm package initialized with `STRIPE_SECRET_KEY` env var
- Three subscription plans mapped to Stripe Price IDs via env vars: `STRIPE_PRICE_INSTITUTION`, `STRIPE_PRICE_NEWSROOM`, `STRIPE_PRICE_AGENCY`
- Publishers table has `stripe_customer_id`, `stripe_subscription_id`, `plan`, `plan_status`, `trial_ends_at` columns
- Webhook handling expected at `/api/billing/webhook`

### Email
- Email sent via Resend API using `fetch()` (no SDK) — key stored as `RESEND_API_KEY`
- Sender address: `hello@inkstain.ai` / `noreply@inkstain.ai`
- Used for: author welcome emails, publisher password reset links, mobile download links

### Data Files (Legacy/Fallback)
Several JSON files exist at root (`accounts.json`, `certificates.json`, `publishers.json`, `waitlist.json`, `stats.json`) — these were the original storage before the Postgres migration. The server now uses Postgres; these files may be stale but should not be deleted without confirming no fallback reads remain in `server.js`.

`schools.json` is still actively used — served by `/api/schools` for the author signup autocomplete.

---

## External Dependencies

| Dependency | Purpose | Config |
|---|---|---|
| **PostgreSQL** | Primary data store for accounts, publishers, certificates, waitlist | `DATABASE_URL` env var |
| **Stripe** | Subscription billing for publisher plans | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` env vars |
| **Resend** | Transactional email (welcome, password reset, download links) | `RESEND_API_KEY` env var |
| **Google Fonts** | Playfair Display + EB Garamond — loaded from CDN in all HTML pages | None (public CDN) |
| **python-docx** | Read Word document metadata in `certificate.py` | Installed via `pip` in start script |
| **reportlab** | Generate PDF certificates in `certificate.py` | Installed via `pip` in start script |
| **pg** (npm) | PostgreSQL client for Node | Installed via npm |
| **stripe** (npm) | Stripe API client for Node | Installed via npm |

### Environment Variables Required
```
DATABASE_URL           — PostgreSQL connection string
STRIPE_SECRET_KEY      — Stripe secret key
STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret
STRIPE_PRICE_INSTITUTION — Stripe Price ID for Institution plan
STRIPE_PRICE_NEWSROOM    — Stripe Price ID for Newsroom plan
STRIPE_PRICE_AGENCY      — Stripe Price ID for Agency plan
RESEND_API_KEY         — Resend transactional email API key
ADMIN_PASSWORD         — Password for the /admin panel
PORT                   — (optional) defaults to 3000
```

### Start Command
```bash
npm start
# Runs: python3 -m pip install python-docx reportlab --quiet && node server.js
```