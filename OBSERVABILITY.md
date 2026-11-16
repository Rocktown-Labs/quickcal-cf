# QuickCalAI observability

## Credentials and deployment

Run `bash scripts/setup-secrets.sh` from a local checkout. It prompts for Google
credentials first, then Sentry, and saves them to GitHub Actions. Input for secrets
is hidden, values are passed through stdin, and blank input preserves existing
values. It deploys `main` afterward; add `--no-deploy` to save without deploying.

| Setting | GitHub location | Purpose |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | Secret | OAuth Web client ID |
| `GOOGLE_CLIENT_SECRET` | Secret | OAuth Web client secret |
| `GOOGLE_IOS_CLIENT_ID` | Secret, optional | Native iOS client |
| `SENTRY_DSN` | Secret | Ingestion DSN; also exposed to the browser as `PUBLIC_SENTRY_DSN` |
| `SENTRY_AUTH_TOKEN` | Secret | CI source-map upload only; never bound to a Worker |
| `SENTRY_ORG` | Variable | Organization slug |
| `SENTRY_PROJECT` | Variable | Project slug |

The old Vercel `NEXT_PUBLIC_SENTRY_DSN` value becomes `SENTRY_DSN`. The other
Sentry values keep their names. No Sentry settings are copied from Vercel by the
script. All Sentry packages are pinned to the same SDK version.

Google authorized JavaScript origins: `https://quickcal-web.rocktown-labs.workers.dev`
and, at cutover, `https://quickcalai.com`. Redirect URIs:

- Current: `https://quickcal-server.rocktown-labs.workers.dev/api/auth/callback/google`
- After cutover: `https://api.quickcalai.com/api/auth/callback/google`

GitHub's Deploy workflow supplies the runtime DSN, uses the commit SHA as the
release, and supplies upload credentials only to the build. Sentry is disabled
when the DSN is absent; source-map uploads require all three build settings.

## Error monitoring and tracing

- Browser: uncaught errors/rejections, caught API 5xx errors, navigation/fetch
  performance traces, Web Vitals, masked session replay (5% of sessions and
  100% of error sessions). Tokens, query strings, cookies, request bodies, user
  identity, and AI input/output content are excluded from error telemetry.
- Web SSR: request isolation, request traces, rendering failures, release tags.
  Uses the Cloudflare SDK inside Astro middleware with Alchemy's `cfContext`.
- API: uncaught/handled 5xx errors, HTTP request counts and duration distributions,
  structured rejection/failure logs, request-scoped D1/R2/AI bindings.
- Background work: Workflow step tracing, processing failures and terminal outcome
  metrics, and Durable Object instrumentation for the rate limiter.
- Cloudflare: persisted invocation logs and traces for both Workers, with URL query
  strings redacted. Sentry samples 20% of traces; Cloudflare samples 20% of traces.
- Build: Vite handles web source maps; Rolldown output hooks handle API source maps.
  Both upload debug-ID artifacts when the CI upload settings are present.

Replay masks text and inputs, blocks media, and is disabled on share, consent,
password-reset, and email-verification pages. Console contents are not forwarded
to Sentry. Operational logs use fixed messages and low-cardinality attributes.

Runtime services are tagged `quickcal-web-browser`, `quickcal-web-ssr`, and
`quickcal-api` for filtering within the existing Sentry project.

## Traks

Site: `quickcalai.com` (`x37823zzxvqxuz7v3h31zcti`). The layout includes the
inline queue and deferred tracker with site key `pb_live_l9jl4w33mwaddxyeoigxbcmq`.
Pageviews, outbound clicks, and downloads are provided by the tracker. Share and
auth-token pages omit the tracker, and the web sends no referrer information.

| Event | Trigger | Properties |
| --- | --- | --- |
| `signup_completed` | Successful email signup | `method=email` |
| `login_completed` | Successful email login | `method=email` |
| `google_signin_started` | Google button clicked | `method=google` |
| `onboarding_completed` | Setup saved or skipped | `outcome=completed/skipped` |
| `extraction_started` | Ingestion accepted by API | None |
| `extraction_completed` | AI processing completed | None |
| `extraction_failed` | Terminal processing failure | `outcome=failed/no_events` |
| `manual_events_created` | Manual creation succeeded | None |
| `checkout_clicked` | Monthly/annual upgrade clicked | `interval=monthly/annual` |

Each event has a matching Traks goal. Three configured funnels cover email signup
to first extraction, returning email login to extraction, and extraction to premium
interest. Google button clicks and checkout clicks measure intent, not successful
registration or payment. No user/document IDs, names, emails, URLs, or schedule
content are added to custom events.
