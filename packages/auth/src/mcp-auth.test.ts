import { describe, expect, test } from "bun:test";
import { Database as BunSqlite } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { unlinkSync } from "node:fs";
import * as authSchema from "../../db/src/schema/auth";
import { createAuth } from "./index";

describe("MCP & OAuth 2.1 integration", () => {
  test("full MCP discovery and JWT authorization flow", async () => {
    const dbPath = "/tmp/test-mcp-suite.db";
    try {
      unlinkSync(dbPath);
    } catch {}

    const sqlite = new BunSqlite(dbPath);
    const statements = [
      "CREATE TABLE user (id text primary key, name text, email text, email_verified integer, image text, stripe_customer_id text, phone_number text, use_case text, calendar_app text, free_credits integer default 1, cal_token text, is_onboarded integer default 0, role text default 'user', banned integer default 0, ban_reason text, ban_expires integer, created_at integer, updated_at integer);",
      "CREATE TABLE session (id text primary key, expires_at integer, token text, created_at integer, updated_at integer, ip_address text, user_agent text, user_id text, impersonated_by text);",
      "CREATE TABLE account (id text primary key, account_id text, provider_id text, user_id text, access_token text, refresh_token text, id_token text, access_token_expires_at integer, refresh_token_expires_at integer, scope text, password text, created_at integer, updated_at integer);",
      "CREATE TABLE verification (id text primary key, identifier text, value text, expires_at integer, created_at integer, updated_at integer);",
      "CREATE TABLE jwks (id text primary key, public_key text, private_key text, created_at integer, expires_at integer, alg text, crv text);",
      "CREATE TABLE oauth_client (id text primary key, client_id text unique, client_secret text, client_discovery_id text, disabled integer, skip_consent integer, enable_end_session integer, subject_type text, scopes text, client_credentials_scopes text, user_id text, created_at integer, updated_at integer, name text, uri text, icon text, contacts text, tos text, policy text, software_id text, software_version text, software_statement text, redirect_uris text, post_logout_redirect_uris text, backchannel_logout_uri text, backchannel_logout_session_required integer, token_endpoint_auth_method text, application_type text, jwks text, jwks_uri text, grant_types text, response_types text, require_pkce integer, dpop_bound_access_tokens integer, reference_id text, metadata text);",
      "CREATE TABLE oauth_resource (id text primary key, identifier text unique, name text, access_token_ttl integer, refresh_token_ttl integer, signing_algorithm text, signing_key_id text, allowed_scopes text, custom_claims text, dpop_bound_access_tokens_required integer, disabled integer, created_at integer, updated_at integer, policy_version integer, metadata text);",
      "CREATE TABLE oauth_client_resource (id text primary key, client_id text, resource_id text, metadata text, created_at integer);",
      "CREATE TABLE oauth_refresh_token (id text primary key, token text unique, client_id text, session_id text, user_id text, reference_id text, authorization_code_id text, resources text, requested_user_info_claims text, expires_at integer, created_at integer, revoked integer, rotated_at integer, rotation_replay_response text, rotation_replay_expires_at integer, auth_time integer, confirmation text, scopes text);",
      "CREATE TABLE oauth_access_token (id text primary key, token text unique, client_id text, session_id text, user_id text, reference_id text, authorization_code_id text, resources text, requested_user_info_claims text, refresh_id text, expires_at integer, created_at integer, revoked integer, confirmation text, scopes text);",
      "CREATE TABLE oauth_consent (id text primary key, client_id text, user_id text, reference_id text, resources text, requested_user_info_claims text, scopes text, created_at integer, updated_at integer);",
      "CREATE TABLE oauth_client_assertion (id text primary key, expires_at integer);",
    ];
    for (const s of statements) sqlite.exec(s);

    const db = (drizzle as any)({ client: sqlite, schema: authSchema });
    const auth = createAuth(
      {
        BETTER_AUTH_SECRET: "test-secret-123456789012345678901234567890",
        BETTER_AUTH_URL: "http://localhost:3000/api/auth",
        CORS_ORIGIN: "http://localhost:3000",
      },
      db as any,
    );

    // 1. Discovery RFC 9728
    const req1 = new Request("http://localhost:3000/.well-known/oauth-protected-resource");
    const res1 = await auth.handler(req1);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { resource: string; authorization_servers: string[] };
    expect(body1.resource).toBe("http://localhost:3000/api/auth/mcp");
    expect(body1.authorization_servers).toContain("http://localhost:3000/api/auth");

    // 2. Auth Server Config
    const req2 = new Request(
      "http://localhost:3000/api/auth/.well-known/oauth-authorization-server",
    );
    const res2 = await auth.handler(req2);
    expect(res2.status).toBe(200);

    // 3. JWT sign & verify
    const signed = await (auth.api as any).signJWT({ body: { payload: { sub: "user_test_999" } } });
    expect(signed?.token).toBeDefined();

    const verified = await (auth.api as any).verifyJWT({ body: { token: signed.token } });
    expect(verified?.payload?.sub).toBe("user_test_999");

    // 4. Invalid token
    const invalid = await (auth.api as any).verifyJWT({ body: { token: "invalid.token" } });
    expect(invalid?.payload).toBeNull();

    // 5. Tokens are bound to the MCP resource and this auth server's issuer.
    // The OAuth provider signs access tokens with `aud = <resource>`; if the
    // jwt plugin keeps the default (bare base URL) audience, verifyJWT rejects
    // every OAuth token.
    const decoded = JSON.parse(Buffer.from(signed.token.split(".")[1]!, "base64url").toString());
    expect(decoded.aud).toBe("http://localhost:3000/api/auth/mcp");
    expect(decoded.iss).toBe("http://localhost:3000/api/auth");

    const wrongAudience = await (auth.api as any).signJWT({
      body: { payload: { sub: "user_test_999", aud: "https://evil.example/mcp" } },
    });
    const wrongAudienceResult = await (auth.api as any).verifyJWT({
      body: { token: wrongAudience.token },
    });
    expect(wrongAudienceResult?.payload).toBeNull();

    const wrongIssuer = await (auth.api as any).signJWT({
      body: { payload: { sub: "user_test_999", iss: "https://evil.example/api/auth" } },
    });
    const wrongIssuerResult = await (auth.api as any).verifyJWT({
      body: { token: wrongIssuer.token },
    });
    expect(wrongIssuerResult?.payload).toBeNull();

    try {
      unlinkSync(dbPath);
    } catch {}
  });
});
