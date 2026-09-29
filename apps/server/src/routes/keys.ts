import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import { createApiKeyRecord, deleteApiKey, listApiKeys } from "@quickcal-cf/db";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { createApiKeySchema } from "../lib/validators";
import { rateLimit } from "../middleware/rate-limit";

const app = new OpenAPIHono<AuthEnv>();
app.use(requireAuth);
app.use(rateLimit({ windowMs: 60_000, maxRequests: 10, keyPrefix: "keys:user" }));

const keySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  keyPrefix: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
});

const listKeys = createRoute({
  method: "get",
  path: "/",
  tags: ["API Keys"],
  summary: "List your API keys (agents use these as Bearer tokens)",
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ keys: z.array(keySummarySchema) }),
      "Your API keys — hashes are never exposed",
    ),
  },
});

app.openapi(listKeys, async (c) => {
  const rows = await listApiKeys(getDb(), c.get("userId"));
  return c.json(
    {
      keys: rows.map((r) => ({
        ...r,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    HttpStatusCodes.OK,
  );
});

const createKey = createRoute({
  method: "post",
  path: "/",
  tags: ["API Keys"],
  summary: "Create an API key (plaintext shown once)",
  request: { body: jsonContentRequired(createApiKeySchema, "Key details") },
  responses: {
    [HttpStatusCodes.CREATED]: jsonContent(
      z.object({
        key: z.string(),
        id: z.string(),
        name: z.string(),
        keyPrefix: z.string(),
        expiresAt: z.string().nullable(),
        createdAt: z.string(),
      }),
      "The new key — store it now, it cannot be recovered",
    ),
  },
});

app.openapi(createKey, async (c) => {
  const { name, expiresInDays } = c.req.valid("json");
  const { key, record } = await createApiKeyRecord(getDb(), {
    userId: c.get("userId"),
    name,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null,
  });
  return c.json(
    {
      key,
      ...record,
      expiresAt: record.expiresAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    },
    HttpStatusCodes.CREATED,
  );
});

const deleteKey = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["API Keys"],
  summary: "Revoke an API key",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(createMessageObjectSchema("Revoked"), "Key revoked"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema("Not found"),
      "Key not found",
    ),
  },
});

app.openapi(deleteKey, async (c) => {
  const { id } = c.req.valid("param");
  const rows = await deleteApiKey(getDb(), c.get("userId"), id);
  if (rows.length === 0) {
    return c.json({ message: "API key not found" }, HttpStatusCodes.NOT_FOUND);
  }
  return c.json({ message: "API key revoked" }, HttpStatusCodes.OK);
});

export default app;
