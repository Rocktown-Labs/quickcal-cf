import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { getUserProfile, isUserBanned, verifyApiKey } from "@quickcal-cf/db";
import { createAuth, getDb } from "../services";
import { ENV } from "../env.server";

export type AuthEnv = {
  Variables: {
    userId: string;
    authMethod: "session" | "api-key" | "oauth";
  };
};

/**
 * Dual Authentication for QuickCalAI & MCP:
 * 1. Better-Auth session cookie (web dashboard / browser session)
 * 2. User API Key (qc_... in Authorization: Bearer header)
 * 3. OAuth 2.1 access token (JWT issued by Better-Auth MCP plugin)
 *
 * For unauthenticated /mcp requests, responds with RFC 9728 WWW-Authenticate
 * advertising the protected resource so OAuth-capable MCP clients can discover
 * the authorization server.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const auth = await createAuth();
  const db = getDb();
  const isMcpRequest = c.req.path === "/mcp" || c.req.path.startsWith("/mcp/");
  const suspended = () => c.json({ message: "Account suspended" }, HttpStatusCodes.FORBIDDEN);

  // 1. Session cookie (web UI)
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session?.user) {
      if (await isUserBanned(db, session.user.id)) return suspended();
      c.set("userId", session.user.id);
      c.set("authMethod", "session");
      return next();
    }
  } catch {
    // Session check failure falls through to bearer auth
  }

  // 2. Bearer header check
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();

    // Option A: API Key (qc_...) for direct agent / CLI usage
    if (token.startsWith("qc_")) {
      const record = await verifyApiKey(db, token);
      if (record) {
        // Banning deletes sessions, but API keys and OAuth tokens outlive
        // them; enforce the moderation flag on every credential type.
        if (await isUserBanned(db, record.userId)) return suspended();
        c.set("userId", record.userId);
        c.set("authMethod", "api-key");
        return next();
      }
    } else if (isMcpRequest) {
      // Option B: OAuth 2.1 JWT access token issued by Better-Auth MCP plugin.
      // These tokens are audience-bound to the /mcp resource, so they must
      // never be accepted by the REST API (which would turn a narrow MCP
      // consent into full account access, e.g. API-key creation).
      try {
        const verified = await (auth.api as any).verifyJWT({ body: { token } });
        const sub = (verified as { payload?: { sub?: string } })?.payload?.sub;
        // Client-credentials tokens carry the OAuth client id in `sub`.
        // Require a real user so a non-user identity can never become a
        // userId in downstream queries.
        if (sub && (await getUserProfile(db, sub)) && !(await isUserBanned(db, sub))) {
          c.set("userId", sub);
          c.set("authMethod", "oauth");
          return next();
        }
      } catch {
        // Invalid or expired JWT falls through to 401
      }
    }
  }

  // If this is an MCP request, return RFC 9728 WWW-Authenticate challenge
  // so MCP clients know how to initiate OAuth 2.1 authorization
  if (isMcpRequest) {
    const resource = `${ENV.BETTER_AUTH_URL.replace(/\/+$/, "")}/mcp`;
    c.header("WWW-Authenticate", `Bearer error="unauthorized", resource="${resource}"`);
  }

  return c.json({ message: "Unauthorized" }, HttpStatusCodes.UNAUTHORIZED);
});
