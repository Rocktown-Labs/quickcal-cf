# QuickCalAI Production Cutover Checklist

This is the ordered runbook for moving `quickcalai.com` from the legacy Vercel + Clerk app to the Cloudflare Workers app. The legacy app stays live as the rollback until every smoke test on the new domain passes.

## Current topology

| Piece | Current | Target |
| --- | --- | --- |
| Web | Vercel (legacy Clerk app) at `https://quickcalai.com` | `quickcal-web` Worker at `https://quickcalai.com` |
| API / auth | Vercel/Clerk (legacy) | `quickcal-server` Worker at `https://api.quickcalai.com` |
| DNS | AWS Route 53 (or the registrar) | Cloudflare zone (needed for Worker custom domains) |
| Users | Clerk | Imported into D1; password users reset, Google users link |
| Data | Legacy Clerk/Vercel stores | D1 + R2; legacy data exported before teardown |

The new app is already deployed on:

- Web: `https://quickcal-web.rocktown-labs.workers.dev`
- API: `https://quickcal-server.rocktown-labs.workers.dev`

`quickcalai.com` still points at the legacy app. Do not remove the Vercel project, its domain, or the Clerk data until the cutover is verified.

## 1. Configure the external services

### Google OAuth

Create a Web application OAuth client (and an iOS client if you ship the native app):

- **Authorized JavaScript origin:** `https://quickcalai.com` (add `https://www.quickcalai.com` if used)
- **Authorized redirect URI:** `https://api.quickcalai.com/api/auth/callback/google`
- For testing before the cutover, also add `https://quickcal-server.rocktown-labs.workers.dev/api/auth/callback/google`.

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_IOS_CLIENT_ID` in the deploy environment.

### Stripe

- Create the Premium product/prices, or let the app create them with the admin sync (step 3).
- Webhook endpoint: `https://api.quickcalai.com/api/auth/stripe/webhook`
- Subscribe to: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`.
- Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PREMIUM_PRICE_ID`, and (if annual billing) `STRIPE_PREMIUM_ANNUAL_PRICE_ID`.
- Use test keys first; switch to live keys only after a test checkout.

### Resend

- Verify the sending domain (`extractions.quickcalai.com`) with SPF/DKIM/DMARC in Resend.
- Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (for example `QuickCalAI <noreply@extractions.quickcalai.com>`).
- No webhook is required for basic sending. `RESEND_WEBHOOK_SECRET` is unused today.

### Sent.dm

- Configure a sending number in the Sent.dm dashboard.
- Set `SENT_DM_API_KEY`.
- Test one SMS to your own number before announcing.

### Auth / origin values

These are security boundaries; get them right:

- `BETTER_AUTH_URL` = the **API/auth origin** (`https://api.quickcalai.com`, or the server Worker URL before cutover).
- `CORS_ORIGIN` = the **web origin** (`https://quickcalai.com`; comma-separate `https://www.quickcalai.com` if used).
- `PUBLIC_SERVER_URL` = the API origin baked into the web bundle (same as `BETTER_AUTH_URL` when using a custom API domain).
- `BETTER_AUTH_SECRET` = a fresh 64-character random string; changing it invalidates sessions and OAuth tokens.
- `ADMIN_USER_IDS` = the owner’s **Better-Auth** user ID (not the Clerk ID). Sign up once, copy the ID from D1 or `/api/user/me`, then set it and redeploy.

## 2. Deploy the latest code

Push to `main` (or run the Deploy workflow manually). The workflow runs type checks and tests before deploying. PR previews are opt-in via the `ENABLE_PREVIEW_DEPLOY` repository variable; production deploys are unchanged.

Confirm the production deploy succeeded:

```bash
gh run list --workflow deploy.yml --limit 5
gh run view <run-id> --log-failed
```

## 3. Bootstrap admin + Stripe plans

1. Sign in to the new app with the owner account.
2. Copy the Better-Auth user ID and set `ADMIN_USER_IDS` in GitHub Actions, then redeploy.
3. Visit `/admin` and run **Sync Stripe products** with live (or test) keys. This writes the Premium plan and price IDs into D1.
4. If you set price IDs manually, confirm `plan.active = 1` in D1.

## 4. Import Clerk users

The live importer reads the Clerk Backend API and writes to remote D1. It preserves Clerk IDs, skips IDs/emails that already exist, preserves Clerk’s email-verification status, and never imports password hashes.

Prerequisites:

- `CLERK_SECRET_KEY`
- `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` (for `wrangler d1 execute --remote`)
- The production D1 database name. The script discovers the single `quickcal-cf-database-prod*` database; pass `--database <name>` if it cannot.

Dry run first:

```bash
CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- --dry-run
```

Review the printed report path (SQL + full JSON report, mode 600) and the skipped-user reasons. Then apply:

```bash
CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- --apply
```

The importer is idempotent: re-running skips existing Clerk IDs and emails. After it finishes, verify the count:

```bash
bunx wrangler d1 execute <database> --remote --json \
  --command "select count(*) as users from user;"
```

Important details:

- Imported users get `free_credits = 1` (the one-time trial).
- Only Clerk-verified addresses are imported as `email_verified = 1`. Unverified addresses must complete the Better-Auth verification flow before they can link a Google account with the same email.
- Password users sign in with **Forgot password** once to create a credential account. Passwords cannot move between auth providers.
- Google users sign in with Google after the OAuth client is configured.
- Existing D1 users (including the owner) are matched by lowercased email and left on their Better-Auth ID.

## 5. Verify migrated accounts

Before sending anything:

- Sign in with one Google-only migrated account.
- Sign in with one password-only migrated account via **Forgot password**.
- Create one upload, review/edit an event, download the `.ics`, create and revoke a share link.
- Send one email and one SMS to your own contacts.
- Connect one MCP client (Claude or Cursor) via OAuth 2.1 or a `qc_…` API key; call `tools/list`, `create_events`, and `check_upload_status`.
- Confirm `/api/user/me` returns the profile and the calendar feed URL.

## 6. Send the announcement email

The D1-backed sender is the recommended one. It reads recipients from D1, excludes test accounts by default, renders the React Email template, and adds `List-Unsubscribe`.

```bash
# Render a preview and print recipients (default; no email sent)
RESEND_API_KEY=re_... bun run email:announcement -- --dry-run

# Single test send to yourself
RESEND_API_KEY=re_... bun run email:announcement -- \
  --to you@example.com --apply --mailing-address "123 Main St" --reply-to you@example.com

# Full send after the domain cutover is verified
RESEND_API_KEY=re_... MAILING_ADDRESS="123 Main St" bun run email:announcement -- \
  --apply --reply-to support@quickcalai.com
```

Notes:

- The default CTA is `https://quickcalai.com/login`. Before the cutover, pass `--login-url https://quickcal-web.rocktown-labs.workers.dev/login` for a test.
- A physical mailing address is required with `--apply` (CAN-SPAM).
- The script excludes test accounts, banned accounts, and unverified emails by default. Pass `--include-unverified` only if you have a reason to mail unverified addresses.
- The script warns if the login URL is a `workers.dev` host.
- Send the full announcement **after** the domain cutover and after Google/Stripe/Resend/Sent.dm are verified, or the email will point at the old app.

## 7. Cut the domain over

Cloudflare Workers custom domains require the `quickcalai.com` zone to be active in the Cloudflare account. The recommended path is to move the DNS zone from AWS to Cloudflare:

1. **Export the current DNS** from Route 53 (or the registrar) and keep it for rollback.
2. Add `quickcalai.com` as a zone in Cloudflare; import the records.
3. Change the nameservers at the registrar/Route 53 to the Cloudflare nameservers. Wait for the zone to become active.
4. In Cloudflare → Workers & Pages → `quickcal-web` → Settings → Domains & Routes, add `quickcalai.com` (and `www` if used).
5. In Cloudflare → Workers & Pages → `quickcal-server` → Settings → Domains & Routes, add `api.quickcalai.com`.
6. Set the GitHub repository variables:
   - `CORS_ORIGIN=https://quickcalai.com` (add `https://www.quickcalai.com` if used)
   - `BETTER_AUTH_URL=https://api.quickcalai.com`
   - `PUBLIC_SERVER_URL=https://api.quickcalai.com`
   - `WEB_CUSTOM_DOMAIN=quickcalai.com`
   - `SERVER_CUSTOM_DOMAIN=api.quickcalai.com`
7. Redeploy production. Alchemy attaches the custom domains when the variables are set. If `CORS_ORIGIN`/`BETTER_AUTH_URL`/`PUBLIC_SERVER_URL` are unset, the workflow derives them from `WEB_CUSTOM_DOMAIN`/`SERVER_CUSTOM_DOMAIN`; setting them explicitly is still preferred when you use `www` or a same-origin API.
8. Update the Google redirect URI to `https://api.quickcalai.com/api/auth/callback/google`.
9. Update the Stripe webhook to `https://api.quickcalai.com/api/auth/stripe/webhook`.
10. The MCP resource becomes `https://api.quickcalai.com/mcp`; re-run one MCP OAuth connection and confirm discovery.

If you cannot move the zone yet, **do not** point `quickcalai.com` at the Worker with an ad-hoc CNAME: Workers custom domains are zone-scoped, and the legacy Vercel app is the safe rollback. Move the zone first, then cut over.

### Cookie / CORS topology

The app is built for split origins:

- Web: `https://quickcalai.com`
- API: `https://api.quickcalai.com`

Session cookies are `SameSite=None; Secure; HttpOnly`, so they work across the two hosts. The Origin-check middleware and CORS allow only `CORS_ORIGIN`. If you instead mount the API on the same host (`https://quickcalai.com/api`), set `BETTER_AUTH_URL=https://quickcalai.com` and route `/api/*`, `/mcp`, `/.well-known/*`, `/doc`, and `/reference` to the server Worker. The split `api.` host is simpler and is the recommended topology.

## 8. Smoke test on the real domain

- `https://quickcalai.com` loads the new landing page.
- `https://quickcalai.com/login` → sign in with password and Google.
- Forgot password → reset → sign in.
- Upload → status → review/edit → download `.ics`.
- Share link → open `/s/{token}` → download; revoke and confirm 404.
- Calendar feed URL → subscribe/refresh; rotate and confirm the old URL stops.
- Email and SMS delivery to your own contacts.
- `/api/user/me`, `/api/keys`, `/mcp` with an API key.
- MCP OAuth 2.1 consent flow (`/consent`).
- `/doc` and `/reference` load.
- Stripe test checkout (or live, if confident) → subscription active → cancel.
- Check Worker logs for 5xx/errors.

## 9. Retire the legacy app

Only after the smoke tests pass:

1. Remove `quickcalai.com` from the Vercel project (keep the deployment for a short rollback window).
2. Delete the old Vercel project and its environment variables.
3. Export/archive Clerk user data, then remove the Clerk application and its keys.
4. Remove the old DNS records from AWS/Route 53 after the Cloudflare zone is authoritative.
5. Rotate any secrets that were shared with the legacy deployment.

## Rollback

Keep the Vercel deployment and the old DNS records until the new app has been stable for a few days. To roll back, point the nameservers/DNS back to Vercel and restore the old records. The D1/R2 data is separate; do not delete it during rollback.

## CI / secrets reference

GitHub Actions secrets:

| Name | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers + D1 + R2 + KV + Workflow + custom-domain permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account (secret or variable) |
| `ALCHEMY_PASSWORD` | Alchemy state encryption |
| `BETTER_AUTH_SECRET` | Auth/JWT signing |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_IOS_CLIENT_ID` | Google OAuth |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PREMIUM_PRICE_ID` / `STRIPE_PREMIUM_ANNUAL_PRICE_ID` | Billing |
| `RESEND_API_KEY` | Email |
| `SENT_DM_API_KEY` | SMS |
| `ADMIN_USER_IDS` | Better-Auth admin allowlist |

GitHub Actions variables:

| Name | Example |
| --- | --- |
| `CORS_ORIGIN` | `https://quickcalai.com` |
| `BETTER_AUTH_URL` | `https://api.quickcalai.com` |
| `PUBLIC_SERVER_URL` | `https://api.quickcalai.com` |
| `WEB_CUSTOM_DOMAIN` | `quickcalai.com` |
| `SERVER_CUSTOM_DOMAIN` | `api.quickcalai.com` |
| `ENABLE_PREVIEW_DEPLOY` | `true` only when preview env is configured |
| `PREVIEW_CORS_ORIGIN` | The preview web origin, if preview deploys are enabled |
| `RESEND_FROM_EMAIL` | `QuickCalAI <noreply@extractions.quickcalai.com>` |

The deploy workflow falls back to the workers.dev URLs when the domain variables are unset.

## Native app builds

The Expo app is in `apps/native`. It needs two public build-time values:

- `EXPO_PUBLIC_SERVER_URL` — the API origin (`https://api.quickcalai.com` in production).
- `EXPO_PUBLIC_WEB_URL` — the web origin (`https://quickcalai.com`), used for public share links
  and auth emails.

Local dev defaults are `http://localhost:3000` and `http://localhost:4321`. For store builds:

```bash
cd apps/native
bunx eas-cli login
bunx eas-cli init                 # links the Expo project (writes extra.eas.projectId)
bunx eas-cli build --profile preview --platform ios
bunx eas-cli build --profile production --platform all
bunx eas-cli submit --profile production --platform ios
```

`apps/native/eas.json` has `preview` (internal APK/device build) and `production` (store builds,
auto-incremented) profiles. Apple Developer, App Store Connect, Google Play, and signing
credentials are external setup. Before submitting, device-test:

- email/password + Google sign-in, sign-out, password reset (web link) and verification;
- first-run onboarding (use cases, calendar app, phone), skip, and the dashboard redirect;
- file/URL/text/manual ingestion, review/edit/delete, .ics download/share;
- share link opens the **web** `/s/{token}` page, not the API;
- email/SMS delivery, API key create/revoke, calendar feed rotate;
- Stripe checkout/billing portal/cancel returning through the public `/billing/return` page and
  the `quickcal-cf://settings` deep link;
- offline/error states (files list retry, status polling retry).

Scanned/image-only PDFs should be shared as PNG/JPG images on native; the web uploader rasterizes
them in the browser, but the native app has no PDF rasterizer.

## Security / behavior notes

- **One-time free credit:** the credit is consumed when the AI workflow starts. It is refunded only if the run never started (validation/storage/workflow-start failure). A failed AI run or unparseable document does not restore it.
- **Banned accounts:** banned users are rejected on session, API-key, and OAuth credentials; expired temporary bans lift automatically.
- **Share links:** public share links and the calendar feed are available on the free tier; Premium gates unlimited AI and email/SMS delivery.
- **Preview deploys:** PR previews need their own `CORS_ORIGIN` and app env; keep `ENABLE_PREVIEW_DEPLOY` unset until that exists.
- **Security audit:** see [SECURITY-AUDIT.md](./SECURITY-AUDIT.md) for the full findings, fixes, and remaining risks.
