import { createMiddleware } from "hono/factory";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { verifyApiKey } from "@quickcal-cf/db";
import { createAuth } from "../services";
import { getDb } from "../services";

export type AuthEnv = {
  Variables: {
    userId: string;
    authMethod: "session" | "api-key";
  };
};

/**
 * Accepts a better-auth session cookie OR a `qc_` API key in the
 * `Authorization: Bearer` header. API keys are how agents and scripts
 * authenticate on behalf of a user.
 */
export const requireAuth = createMiddleware<AuthEnv>(async (c, next) => {
  const auth = await createAuth();

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) {
    c.set("userId", session.user.id);
    c.set("authMethod", "session");
    return next();
  }

  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const record = await verifyApiKey(getDb(), header.slice("Bearer ".length).trim());
    if (record) {
      c.set("userId", record.userId);
      c.set("authMethod", "api-key");
      return next();
    }
  }

  return c.json({ message: "Unauthorized" }, HttpStatusCodes.UNAUTHORIZED);
});
