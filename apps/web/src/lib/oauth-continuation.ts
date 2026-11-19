import { ENV } from "../env.public";

const SERVER_ORIGIN = ENV.PUBLIC_SERVER_URL.replace(/\/+$/, "");
const OAUTH_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
const OAUTH_CONSENT_PATH = "/api/auth/oauth2/consent";

/**
 * The MCP OAuth provider redirects to /login or /signup with the signed
 * authorization query. Once the user has a session, sending them back to the
 * authorize endpoint lets the provider continue to consent or issue a code.
 */
export function oauthAuthorizeUrl(): string | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  if (!params.get("client_id") || !params.get("sig")) return null;
  // A failed authorization returns here with `error`; continuing would loop.
  if (params.get("error")) return null;

  // Forward only OAuth parameters, not arbitrary tracking/next params.
  const allowed = [
    "client_id",
    "sig",
    "scope",
    "state",
    "response_type",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
    "resource",
  ];
  const forwarded = new URLSearchParams();
  for (const key of allowed) {
    const value = params.get(key);
    if (value) forwarded.set(key, value);
  }

  return `${SERVER_ORIGIN}${OAUTH_AUTHORIZE_PATH}?${forwarded.toString()}`;
}

export function oauthConsentUrl(): string {
  return `${SERVER_ORIGIN}${OAUTH_CONSENT_PATH}`;
}
