# QuickCalAI Production Checklist

This file tracks what is done, what is skipped, and what is still needed to ship QuickCalAI to `https://quickcalai.com`.

## What is already done

- [x] Editorial/minimal homepage redesign (black + red, no gradients/glows/floating cards).
- [x] Light/dark mode theme switcher.
- [x] Google OAuth wired into Better-Auth (`/login`, `/signup` buttons included).
- [x] Better-Auth admin plugin + DB migration for `role`, `banned`, etc.
- [x] Stripe billing now uses dynamic plans from the `plan` table.
- [x] Admin sync page at `/admin` creates Stripe products and prices.
- [x] Theme cleanup across Dashboard, Files, Settings (removed gradients and hardcoded colors).
- [x] Infra bindings updated for all new env vars.
- [x] Sent.dm SMS integration verified as per-request client pattern.
- [x] `bun run check-types` passes and `bun run dev` starts.

## Required secrets (not all are known yet)

Set these as GitHub Actions secrets, Cloudflare Worker secrets, or in `apps/server/.env` before deploying.

| Secret | Status | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | ??? | Auth session signing |
| `CORS_ORIGIN` | Use `https://quickcalai.com` | Allowed web origin |
| `BETTER_AUTH_URL` | Use `https://quickcalai.com` | Auth base URL |
| `GOOGLE_CLIENT_ID` | **Missing** | Google sign-in |
| `GOOGLE_CLIENT_SECRET` | **Missing** | Google sign-in |
| `GOOGLE_IOS_CLIENT_ID` | Optional | iOS Google sign-in |
| `ADMIN_USER_IDS` | Optional | Bootstrap admins before sign-up |
| `STRIPE_SECRET_KEY` | **Missing** | Stripe API |
| `STRIPE_WEBHOOK_SECRET` | **Missing** | Stripe webhook verification |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Set in GitHub Actions | AI extraction |
| `RESEND_API_KEY` | Set in GitHub Actions | Email delivery |
| `RESEND_FROM_EMAIL` | Suggested: `QuickCalAI <noreply@extractions.quickcalai.com>` | Email sender |
| `SENT_DM_API_KEY` | Set in GitHub Actions | SMS delivery |

## Deployed URLs (prod stage via GitHub Actions)

- **Web:** https://quickcal-web.rocktown-labs.workers.dev
- **API / Better-Auth:** https://quickcal-server.rocktown-labs.workers.dev

After custom DNS is configured, these should become `https://quickcalai.com` and `https://quickcalai.com/api` (or a separate server subdomain).

## Current status

- ✅ GitHub Actions workflow at `.github/workflows/deploy.yml` deploys on push to `main` (and PR previews).
- ✅ Production deployed with dummy optional keys.
- ✅ Email sign-up works at `https://quickcal-server.rocktown-labs.workers.dev/api/auth/sign-up/email`.
- ⚠️ Google/Stripe features are disabled until real keys are set and synced via `/admin`.

## External dashboard configuration

### Google OAuth
- Authorized redirect URI: `https://quickcal-server.rocktown-labs.workers.dev/api/auth/callback/google`
  - Update to `https://quickcalai.com/api/auth/callback/google` when custom DNS is ready.

### Stripe
- Webhook endpoint: `https://quickcal-server.rocktown-labs.workers.dev/api/auth/stripe/webhook`
  - Update to `https://quickcalai.com/api/auth/stripe/webhook` when custom DNS is ready.
- Required events:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

### Resend
- No webhook needed for basic sending.
- Sending domain: `extractions.quickcalai.com`
- `RESEND_FROM_EMAIL` example: `QuickCalAI <noreply@extractions.quickcalai.com>`

### Sent.dm
- Make sure a sending number is configured in the Sent.dm dashboard before using the SMS feature.

## Skipped for now

- **Resend webhooks.** `RESEND_WEBHOOK_SECRET` is not being used. Can be added later if you want to track bounces, complaints, opens, or clicks.

## Still needed before launch

1. Add remaining secrets (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`).
2. Configure Stripe and Google dashboards with the URLs above.
3. Configure Cloudflare DNS for `quickcalai.com` to point to the deployed web Worker.
4. Deploy (first preview, then production).
5. Sign up the first user, make them admin (`ADMIN_USER_IDS`), then visit `/admin` and run **Sync Stripe products**.
6. Migrate users from Clerk to Better-Auth.

## Deploy with GitHub Actions

A deploy workflow lives at `.github/workflows/deploy.yml`. It runs on pushes to `main`, PRs (preview), and manual dispatch.

### Required repository secrets / variables

Create these in GitHub before the first deploy:

| Name | Type | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | Cloudflare API token with Workers + Pages + D1 + R2 + KV + Workflow permissions |
| `CLOUDFLARE_ACCOUNT_ID` | variable | Your Cloudflare account ID |
| `ALCHEMY_PASSWORD` | secret | Password Alchemy uses to encrypt state (generate once and keep safe) |

### App secrets status

| Secret | Status | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | ✅ set | Real random secret generated |
| `GOOGLE_GENERATIVE_AI_API_KEY` | ✅ set | User-provided |
| `RESEND_API_KEY` | ✅ set | User-provided |
| `SENT_DM_API_KEY` | ✅ set | User-provided |
| `GOOGLE_CLIENT_ID` | ⚠️ dummy | Replace with real values when ready |
| `GOOGLE_CLIENT_SECRET` | ⚠️ dummy | Replace with real values when ready |
| `STRIPE_SECRET_KEY` | ⚠️ dummy | Replace with real `sk_test_...` / `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | ⚠️ dummy | Replace after configuring Stripe webhook |
| `ADMIN_USER_IDS` | ⚠️ dummy | Set to your user ID after first admin sign-up, then re-run workflow |
| `RESEND_WEBHOOK_SECRET` | ⚠️ dummy | Skipped for now |

Replace dummy values with real ones in the GitHub Actions secrets page. The app will start and degrade gracefully while optional keys are still dummies.

### Deploy commands

```bash
# Manual workflow run from GitHub UI, or just push to main
# Deploy preview from a PR automatically
```

Plan this separately from launch unless launch is gated on existing users:

- Export Clerk users (email, hashed password if available, name, user ID).
- For users with passwords, Better-Auth does not allow importing hashes; options are:
  - Password reset emails,
  - Magic-link login,
  - Import accounts and force password reset on next login.
- Preserve old user IDs or map Clerk ID → Better-Auth ID in a lookup table so existing data links remain valid.
