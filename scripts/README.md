# Scripts

These are one-off operational scripts. None of them run during a deploy.

## Clerk user import

### `migrate-clerk-users.ts` (recommended)

Fetches users directly from the Clerk Backend API and writes them to D1. It preserves Clerk IDs, skips emails that already exist in D1, sets `email_verified = 1` for Google account linking, and never imports password hashes.

```bash
CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- --dry-run
CLERK_SECRET_KEY=sk_... bun run migrate:clerk-users -- --apply
```

Options:

- `--dry-run` writes SQL and a report without touching D1.
- `--apply` executes the generated SQL against remote D1.
- `--database <name>` selects a D1 database. Defaults to `D1_DATABASE_NAME` or the single production database Wrangler can see.

Password users complete the Better-Auth reset flow on first sign-in. Google users sign in with Google after the OAuth credentials are configured.

### `import-clerk-users.ts` (offline variant)

Reads a Clerk JSON export and generates a SQL file. Use this only if the Clerk API is unavailable.

```bash
bun run scripts/import-clerk-users.ts --file clerk-users.json --owner-email you@example.com
```

This variant generates SQL only. The live importer above is the one that applies changes to D1.

## Announcement email

### `send-announcement.ts` (recommended)

Reads recipients from D1, excludes test accounts by default, renders the React Email template, and sends through Resend. The default is a dry run.

```bash
RESEND_API_KEY=re_... bun run email:announcement -- --dry-run
RESEND_API_KEY=re_... MAILING_ADDRESS="123 Main St" bun run email:announcement -- --apply
```

Useful options:

- `--to <email>` sends only to one address. Use this for a test send.
- `--exclude <emails>` skips comma-separated addresses. Useful when one person has two accounts.
- `--limit <n>` sends to the first n recipients.
- `--include-test` includes `@example.com` and `@quickcalai.test` accounts.
- `--login-url <url>` changes the CTA destination.
- `--reply-to <address>` sets a real Reply-To inbox so replies do not bounce off the noreply sender.

The script adds a `List-Unsubscribe` header. A mailing address is required with `--apply`.

Do not send until Google OAuth works and `quickcalai.com` points at the new app.

### `send-announcement-email.ts` (offline variant)

Reads recipients from a Clerk JSON export instead of D1. Useful for a test send or a pre-migration announcement.

```bash
bun run scripts/send-announcement-email.ts --file clerk-users.json
bun run scripts/send-announcement-email.ts --test-recipient you@example.com --send
```

The D1-backed `send-announcement.ts` is the recommended sender after migration.
