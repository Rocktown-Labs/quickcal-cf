#!/usr/bin/env bash
# Run from any directory. Values are read from the terminal, never CLI arguments.
set +x
set -euo pipefail
unset GH_DEBUG

repo="Rocktown-Labs/quickcal-cf"
command -v gh >/dev/null || { echo "Install GitHub CLI first: brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Sign in first: gh auth login"; exit 1; }

set_secret() {
  local secret_name="$1" secret_description="$2" secret_value=""
  printf '\n%s — %s\n' "$secret_name" "$secret_description"
  printf 'Value (hidden; Enter keeps the existing value): ' >/dev/tty
  IFS= read -r -s secret_value </dev/tty
  printf '\n' >/dev/tty
  if [[ -n "$secret_value" ]]; then
    printf '%s' "$secret_value" | gh secret set "$secret_name" --repo "$repo"
    printf 'Saved %s.\n' "$secret_name"
  else
    printf 'Kept %s unchanged.\n' "$secret_name"
  fi
  unset secret_value
}

set_variable() {
  local variable_name="$1" variable_description="$2" variable_value=""
  printf '\n%s — %s\n' "$variable_name" "$variable_description"
  printf 'Value (Enter keeps the existing value): ' >/dev/tty
  IFS= read -r variable_value </dev/tty
  if [[ -n "$variable_value" ]]; then
    printf '%s' "$variable_value" | gh variable set "$variable_name" --repo "$repo"
    printf 'Saved %s.\n' "$variable_name"
  else
    printf 'Kept %s unchanged.\n' "$variable_name"
  fi
  unset variable_value
}

printf 'QuickCalAI Google + Sentry setup\nRepository: %s\n' "$repo"
printf 'Paste values without surrounding quotes. Blank input never deletes an existing setting.\n'

set_secret GOOGLE_CLIENT_ID 'Google OAuth Web application client ID (*.apps.googleusercontent.com)'
set_secret GOOGLE_CLIENT_SECRET 'Google OAuth Web application client secret'
set_secret GOOGLE_IOS_CLIENT_ID 'Optional iOS OAuth client ID; skip for the web launch'
set_secret SENTRY_DSN 'Use the old NEXT_PUBLIC_SENTRY_DSN value; used by browser and Workers'
set_secret SENTRY_AUTH_TOKEN 'Sentry build/source-map upload token; stays in CI'
set_variable SENTRY_ORG 'Sentry organization slug (not its display name)'
set_variable SENTRY_PROJECT 'Sentry project slug (not its display name)'

printf '\nGoogle authorized redirect URIs:\n'
printf '  Now: https://quickcal-server.rocktown-labs.workers.dev/api/auth/callback/google\n'
printf '  After domain cutover: https://api.quickcalai.com/api/auth/callback/google\n'
printf 'Google authorized JavaScript origins:\n'
printf '  https://quickcal-web.rocktown-labs.workers.dev\n  https://quickcalai.com\n'

if [[ "${1:-}" == "--no-deploy" ]]; then
  printf '\nSaved settings. Deploy later with:\n  gh workflow run deploy.yml --repo %s --ref main\n' "$repo"
else
  gh workflow run deploy.yml --repo "$repo" --ref main
  printf '\nDeployment requested. Watch progress at:\n  https://github.com/%s/actions/workflows/deploy.yml\n' "$repo"
fi
