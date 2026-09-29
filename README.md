# QuickCalAI

QuickCalAI turns schedule documents into calendar files. Upload a screenshot, photo, or PDF containing a
schedule — a class timetable, conference agenda, shift roster, event flyer — and QuickCalAI uses Google
Gemini to read every date and time, then generates a standard `.ics` calendar file that imports into
Google Calendar, Apple Calendar, Outlook, and any other calendar app.

Free accounts can create single events by hand. Premium accounts ($12.99/mo or $71.88/yr via Stripe)
unlock AI extraction from uploads, plus email (Resend) and SMS (Sent.dm) delivery and public share links.

## How it works

```
image/PDF ──▶ POST /api/uploads ──▶ R2 (source file) ──▶ Cloudflare Workflow
                                                          │
                    ┌───────────────────────────────────┘
                    ▼
            Gemini "is this a calendar?" (gemini-2.5-pro)
                    ▼
            Gemini event extraction (gemini-2.5-flash)
                    ▼
            events rows (D1) + .ics file (R2) + share token
                    ▼
            poll status ──▶ download / email / SMS / public share link
```

1. The browser uploads the file to the API (`multipart/form-data`, ≤ 10 MB, JPEG/PNG/WebP/PDF).
2. The API stores the file in R2, records an upload row in D1, and starts a Cloudflare Workflow.
3. The workflow asks Gemini whether the document is a calendar, then extracts events as a validated
   JSON array (`date` YYYY-MM-DD, `time` HH:MM, `description`).
4. It writes an `.ics` to R2, inserts event rows, and marks the upload `completed` with a public
   share token (or `no_events` / `failed`).
5. The dashboard polls status and offers download, copy-link, device share, email, and SMS delivery.
   A public share page (`/s/{token}`) shows the events and serves the `.ics` (also `webcal://`
   subscribable).

## Architecture

Bun + Turborepo monorepo, deployed entirely to Cloudflare via [Alchemy](https://alchemy.run):

| App | What it is |
| --- | --- |
| `apps/web` | Astro site — marketing landing page, login/signup, dashboard, uploader, files, settings, share pages, legal/help, password reset & email verification. Deployed as the `quickcal-web` Worker. |
| `apps/server` | Hono OpenAPI API + Better-Auth handler + the `CalendarProcessingWorkflow` + a `RateLimiter` Durable Object. Deployed as the `quickcal-server` Worker. Serves `/doc` (OpenAPI) and `/reference` (Scalar). |
| `apps/native` | Expo/React Native app mirroring the mobile web app 1:1 — sign in/up, dashboard with the AI uploader (premium gate, live processing steps/progress, delivery), files (download/share/copy/email/SMS/revoke/delete), settings (profile, subscription, API keys, theme). Sessions via Better-Auth Expo plugin + SecureStore; data via TanStack Query. |

| Package | What it is |
| --- | --- |
| `packages/db` | Drizzle schema (uploads, events, api keys, Better-Auth tables, Stripe billing tables), query helpers, ICS generation, D1 migrations. |
| `packages/auth` | Better-Auth factory: email/password + Google OAuth, admin + Expo + Stripe subscription plugins. |
| `packages/infra` | Alchemy IaC — D1 database, R2 bucket, Workflow, both Workers, and deploy-time env wiring (Varlock). |

### Storage & bindings

- **Cloudflare D1** (SQLite, Drizzle ORM) — users, sessions, uploads, events, API keys, subscriptions, plans.
- **Cloudflare R2** — source documents under `uploads/{userId}/…`, generated calendars under `ics/{shareToken}.ics`. Private; nothing is served except through the API.
- **Cloudflare Workflows** — durable AI processing pipeline.
- **Better-Auth** — sessions via cookies (SameSite=None for the split web/API origins) or `Authorization: Bearer qc_…` user API keys for agents/scripts. API keys are stored SHA-256-hashed; plaintext is shown once at creation.
- **Security** — an Origin-check middleware guards all state-changing routes (CSRF defense for the `SameSite=None` cookies), rate limiting is backed by a `RateLimiter` Durable Object shared across isolates, uploads are validated by magic-byte signatures, and share links can be revoked from the Files screen. Password reset and email verification flow through Resend.

## Getting started

```bash
bun install          # also runs varlock codegen (postinstall)
bun run dev          # web on :4321, API on :3000 (via alchemy dev)
```

Copy `.env.example` to `apps/server/.env` and fill in values. For the native app, set
`EXPO_PUBLIC_SERVER_URL` in `apps/native/.env`.

Generate/refresh typed env accessors after editing any `.env.schema`:

```bash
bun run env:generate
```

### Database

Cloudflare D1 with Drizzle. Alchemy provisions the database and applies the migrations in
`packages/db/src/migrations` during deploy. To generate a new migration:

```bash
bun run db:generate
```

## Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Start web + API in dev mode (Alchemy) |
| `bun run build` | Build the server bundle (web is built at deploy time by Alchemy) |
| `bun run check-types` | TypeScript / Astro type check across all packages |
| `bun run test` | Unit tests (`packages/db`, `apps/server`) |
| `bun run dev:native` | Expo dev server |
| `bun run db:generate` | Generate a Drizzle migration |
| `bun run env:generate` | Regenerate Varlock env accessors |
| `bun run deploy` / `destroy` | Alchemy deploy/destroy (interactive) |
| `bun run check` | Oxlint + oxfmt over the server, web, and packages |

Lint/format also runs via lefthook on commit (oxlint + oxfmt on staged files).

## Deployment

Deploys are managed with Alchemy from `packages/infra`. GitHub Actions (`.github/workflows/deploy.yml`)
deploys on push to `main` (stage `prod`) and per-PR preview stages.

- Production web: https://quickcal-web.rocktown-labs.workers.dev
- Production API: https://quickcal-server.rocktown-labs.workers.dev
- Deploy manually: `cd packages/infra && bunx alchemy deploy --stage prod`

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the launch checklist and the current state of each secret
(Google OAuth and Stripe keys are still placeholders).

### Environment / secrets

Server (validated by Varlock against `apps/server/.env.schema`; wired in `packages/infra/alchemy.run.ts`):

`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `CORS_ORIGIN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PREMIUM_PRICE_ID` (optional), `STRIPE_PREMIUM_ANNUAL_PRICE_ID` (optional),
`GOOGLE_GENERATIVE_AI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (optional), `SENT_DM_API_KEY`,
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_IOS_CLIENT_ID` (optional), `ADMIN_USER_IDS` (optional).

Web: `PUBLIC_SERVER_URL` (injected by Alchemy). Native: `EXPO_PUBLIC_SERVER_URL`.

After the first production deploy, set `CORS_ORIGIN` to the exact deployed web origin.

## Project structure

```
quickcal-cf/
├── apps/
│   ├── web/          # Astro marketing + product site (Workers)
│   ├── server/       # Hono API + Better-Auth + Workflow (Workers)
│   └── native/        # Expo app (scaffold)
├── packages/
│   ├── auth/          # Better-Auth factory
│   ├── config/        # Shared tsconfig
│   ├── db/            # Drizzle schema, queries, ICS, migrations
│   └── infra/         # Alchemy IaC for all Cloudflare resources
└── .github/workflows/deploy.yml
```

## Status

- Web and API are deployed and functional end-to-end (email auth with verification + password reset,
  uploads, extraction, share links with revocation, admin Stripe sync). Google OAuth and Stripe
  checkout are dormant until real keys replace the placeholders. The native app mirrors the mobile
  web app (auth, uploader, files, settings) and needs a device build pass before store submission.
  See [DEPLOYMENT.md](./DEPLOYMENT.md) for the launch checklist and the security work already done.
