# Security Audit — QuickCalAI (`quickcal-cf`)

- **Date:** 2026-10-29
- **Scope:** `apps/server`, `apps/web`, `apps/native`, `packages/auth`, `packages/db`, `packages/email`, `packages/infra`, `scripts`, `.github/workflows`
- **Source:** current worktree (includes the uncommitted MCP/OAuth feature)
- **Method:** source review plus local unit tests and `bun audit`. No deployed endpoint, live credential, or third-party account was probed.
- **Baseline:** full `bun test` — 89 passing tests; `bun run check-types` — 0 errors.

## Fixed and verified

### 1. OAuth 2.1 access tokens were rejected at `/mcp` (issuer/audience mismatch)

`requireAuth` verified JWTs with `auth.api.verifyJWT`, which defaults `iss`/`aud`
to the bare `BETTER_AUTH_URL`. The MCP OAuth provider signs access tokens with
`iss = <baseURL>/api/auth` and `aud = <baseURL>/mcp`, so every OAuth token was
rejected (the advertised OAuth flow was unusable).

**Fix:** configure the `jwt` plugin with the concrete issuer/audience
(`packages/auth/src/index.ts`), and only accept OAuth JWTs on `/mcp` so a
narrow MCP consent cannot be replayed against the REST API.

**Evidence:**

- Before the fix, a token with `aud = /mcp` verified to `{"payload":null}`.
- After the fix, the same token verifies; tokens with the bare origin or an
  attacker origin are still rejected.
- Regression tests: `packages/auth/src/mcp-auth.test.ts` (audience/issuer
  assertions) and `packages/auth/src/issuer.test.ts`.

### 2. MCP event edits/deletes left stale public `.ics` files

The REST routes regenerated the public calendar after an edit/delete; the MCP
`update_event` and `delete_event` tools only changed the database row. A
deleted event kept being served from a previously shared link.

**Fix:** shared `refreshUploadIcs` / `updateEventAndRefreshIcs` /
`deleteEventAndRefreshIcs` helpers (`apps/server/src/lib/refresh-ics.ts`,
`event-mutations.ts`), used by both transports. Deleting the last event still
revokes the share token and removes the object.

**Evidence:** `apps/server/src/lib/refresh-ics.test.ts` — 7 passing tests,
including “delete removes the event from the public .ics” and “last delete
revokes the share link”.

### 3. URL ingestion followed redirects without re-validating the SSRF guards

`fetchIngestDocument` validated the initial URL, then used
`fetch(..., { redirect: "follow" })`. A public URL could redirect to
`http://169.254.169.254`, loopback, or a private address without another check.
Cloudflare Workers block RFC1918 egress, but the guard was wrong on its own and
would matter for any self-hosted/alternative runtime.

**Fix:** follow redirects manually (`redirect: "manual"`), re-run
`assertFetchableUrl` on every `Location`, cap redirects, and reject
loopback/RFC1918/CGNAT/link-local/IPv4-mapped/trailing-dot hosts. Webhook
delivery now uses `redirect: "error"`.

**Evidence:** `apps/server/src/lib/fetch-document.test.ts` — redirects to
`http://169.254.169.254` and `https://127.0.0.1` are rejected without a second
fetch; a safe redirect is followed and validated.

### 4. Idempotency-Key replays returned an empty `{}` response

The handlers return a `Response`; the old code stored
`JSON.stringify(response)` (`"{}"`), so an agent retrying an ingestion got an
empty 200 instead of the original `uploadId`/`runId`/`shareToken`.

**Fix:** store the response status/body/content-type and rebuild the response on
replay (`apps/server/src/lib/ingest.ts`).

**Evidence:** `apps/server/src/lib/idempotency.test.ts` — replay preserves the
202 status, body, and `Idempotency-Replayed` header; keys stay user-scoped.

### 5. Banned users retained API-key and OAuth access

Banning deletes sessions in Better-Auth, but API keys and stateless OAuth JWTs
outlive the session. `requireAuth` now checks `isUserBanned` for every
credential type (and `requireAdmin` checks it too). Expired temporary bans lift
automatically.

### 6. Missing request-body caps on ingestion/MCP/JSON routes

`formData()`/`c.req.json()` buffered the whole request before the 10 MB/100 KB
checks. Added `bodyLimit` middleware plus early `Content-Length` checks for
uploads, text, URL, structured events, delivery, manual events, admin, and MCP.
Oversized bodies now return 413 before allocation.

### 7. Share `.ics` was cacheable after revocation

`/api/share/{token}/ics` sent `Cache-Control: public, max-age=3600`. Revoking a
link cleared the token/object, but a browser or intermediary cache could keep
serving the file for an hour. Changed to `Cache-Control: no-store` (and added
`X-Content-Type-Options: nosniff`).

### 8. HTML-injection hygiene / self-XSS (not a cross-user finding)

- The manual-event list in `Uploader.astro` interpolated `location` (and title)
  into `innerHTML` without full escaping. The value comes from the same user's
  form, so this was self-XSS rather than a cross-user boundary; it is fixed
  with `escapeHtml`.
- The Files page interpolated an API error message into `innerHTML`. Now
  escaped.
- Email subjects interpolated the client-supplied filename. CR/LF are stripped
  before building the subject.

### 9. `ADMIN_USER_IDS` was documented but not honored

The Better-Auth admin plugin uses `adminUserIds` for its own endpoints but does
not write `user.role`. The custom `/api/admin` guard only checked `role`, so
deploy-time allowlisted admins were denied. `requireAdmin` now accepts either
the role or the env allowlist.

### 10. Workflow retries could duplicate events

The `persist` step inserted events one by one. A retry after a partial failure
re-ran the insert. The step now clears the upload's event rows before
re-inserting, making it idempotent.

### 11. Free-trial credit could be farmed by forcing failures

The workflow refunded the free credit on any failed run, so a user could force
an unparseable extraction and get the credit back repeatedly (unlimited free AI
work). The credit is now consumed when the workflow **starts**; only failures
before the run starts (validation, storage, workflow-start failure) refund it.
The web/native uploaders refresh the credit banner after a terminal run.

### 12. Clerk import marked every address as verified

Both Clerk importers hard-coded `email_verified = 1`. That would let an
unverified address link to a Google account with the same email. The importers
now preserve Clerk’s per-address `verification.status`; only verified addresses
are imported verified. The announcement sender also excludes unverified and
banned accounts by default (`scripts/send-announcement.test.ts` covers the
filters).

### 13. Dependency advisories (runtime)

- `better-auth` 1.7.5 → 1.7.14 (fixes the critical OAuth-state/Magic-Link
  advisory GHSA-965c-763c-88jm and the high OAuth-proxy advisory
  GHSA-r4xp-prcw-77qf; the app does not use Magic Link, so the critical path was
  not reachable, but the upgrade removes it).
- `zod` 4.6.5 → 4.6.7 (GHSA-mrhx-c7xc-m3w5, high, oversized collection
  validation).
- `bun audit` no longer reports either package's advisories (the package names
  still appear as dependency paths for unrelated build-tool advisories).

### 14. Mobile app parity and shared-device privacy

- **Share links used the API origin.** The native uploader/files screens copied
  `${EXPO_PUBLIC_SERVER_URL}/s/{token}`, but the public share page is served by
  the web app. Added `EXPO_PUBLIC_WEB_URL` and routed all share/copy links
  through it.
- **Native Stripe buttons were no-ops.** Better-Auth’s redirect plugin is
  browser-only, so `subscription.upgrade`/`billingPortal`/`cancel` returned a
  URL the app ignored. The app now disables the server redirect, opens the
  Stripe URL in the in-app browser, returns through the public
  `/billing/return` page, deep-links to `quickcal-cf://settings`, and refetches
  the profile. Annual billing was added.
- **Auth screens didn’t navigate after success.** Login/signup now redirect on
  success and when already authenticated; Google signup is available; the
  verification banner defaults to visible until the email is confirmed.
- **First-run onboarding** mirrors the web questionnaire (use cases, calendar
  app, optional phone, skip); un-onboarded users are redirected from the tabs.
- **Shared-device cache leak.** The React Query cache is cleared when the
  signed-in user changes (including sign-out), so a second user cannot briefly
  see the previous profile/premium state/uploads/API keys.
- **Mobile reliability:** safe-area top padding, status-polling 404 retries and
  an error state instead of an infinite spinner, files/stats/API-key error +
  retry states, and wall-clock-correct event date/time pickers.
- Expo SDK patch updates, `eas.json` preview/production profiles with the
  production `EXPO_PUBLIC_*` origins, and an app description were added.
  `expo export` and `expo prebuild` both succeed.

### 15. Hardening

- Added baseline response headers on the web app (`X-Content-Type-Options`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) and on the
  API (`nosniff`, `no-referrer`, `Cache-Control: no-store` for `/api/*` so
  API keys/webhook secrets/feed tokens are never cached).
- Made optional integrations genuinely optional in the env schema (Stripe,
  Resend, Sent.dm) so a deploy without them starts and returns clear
  configuration errors instead of failing validation.
- Added optional Alchemy custom-domain wiring (`WEB_CUSTOM_DOMAIN`,
  `SERVER_CUSTOM_DOMAIN`, `PUBLIC_SERVER_URL`) and documented the AWS DNS →
  Cloudflare cutover, Clerk import, announcement, and Vercel retirement steps
  in `README.md` / `DEPLOYMENT.md`.
- The workflow now writes its own run id from `event.instanceId` during
  `mark-processing`, so `/by-run/{runId}/status` resolves even if the
  ingestion route's best-effort bookkeeping write failed.
- `RESEND_FROM_EMAIL` is a repository variable (with the previous address as a
  fallback) instead of a hardcoded workflow value.
- Production 5xx responses no longer echo internal error messages/stacks; MCP
  unexpected tool errors return a generic message.
- Added a 5/min per-user cap on premium email/SMS delivery (abuse/cost).
- Redacted webhook URLs in workflow logs (query tokens).
- Removed internal `createdAt` from the public share JSON.
- CI: run `packages/auth` tests and pin Bun to the lockfile generator.

## Rejected after verification

| Candidate | Why it is not a finding |
| --- | --- |
| ICS property injection via event title/location | The `ics` library escapes CR/LF to literal `\n`; no `ATTENDEE:`/`URL:` property injection. |
| Hono auth bypass via `/api/uploads` vs `/api/uploads/*` | Probed: the wildcard middleware matches the bare mount; no unauthenticated handler. |
| Hono auth bypass via `..`/`%2e%2e`/encoded slash | Probed: Hono normalizes and routes to the correct scoped middleware. |
| Account pre-hijacking via unverified email + Google linking | Better-Auth’s `requireLocalEmailVerified` defaults to `true`; an unverified local account cannot be linked. |
| Magic-Link OAuth-state CVE | The app does not enable the Magic Link plugin; upgraded anyway. |
| IDOR on uploads/events/keys/feed | Every owner-facing query is scoped by `userId`; share/feed access is by 256-bit token. |
| Open redirect in OAuth continuation | The provider validates the signed authorize query and registered redirect URIs; the consent page only navigates to the server-returned `redirect_uri`. |

## Needs validation / remaining risk

- **Cloudflare private-IP egress:** the SSRF fixes assume the platform blocks
  RFC1918/loopback egress. Verified by documentation/behavior, not by probing a
  deployed Worker.
- **Build-time advisories:** `bun audit` still reports high/critical advisories
  in build tooling (`shell-quote` via React Native CLI, `hono@4.11.4` via
  Alchemy, `undici`/`sharp`/`lodash`/`node-forge` via Astro/Alchemy/Expo).
  None are in the deployed server bundle (`apps/server/dist/index.mjs` contains
  no `undici`/`lodash`/`sharp`/`node-forge`/`shell-quote`), but the toolchain
  should be upgraded on its own cadence.
- **CSP:** baseline headers were added, but a strict CSP (nonce/hash-based) is
  not in place; inline theme/hydration scripts make this a separate change.
- **OAuth JWT revocation:** access tokens are stateless and remain valid until
  their ~1h expiry even if the client is revoked.
- **Banned users’ public share/feed links:** banning a user does not revoke
  already-created public share tokens or calendar feed tokens.
