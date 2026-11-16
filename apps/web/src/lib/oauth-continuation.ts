import { ENV } from "../env.public";

/**
 * The MCP OAuth provider redirects to /login or /signup with the signed
 * authorization query. Once the user has a session, sending them back to the
 * authorize endpoint lets the provider continue to consent or issue a code.
 */
export function oauthAuthorizeUrl(): string | null {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  if (!params.get("client_id") || !params.get("sig")) return null;

  return `${ENV.PUBLIC_SERVER_URL}/api/auth/oauth2/authorize${window.location.search}`;
}

export function oauthConsentUrl(): string {
  return `${ENV.PUBLIC_SERVER_URL}/api/auth/oauth2/consent`;
}
