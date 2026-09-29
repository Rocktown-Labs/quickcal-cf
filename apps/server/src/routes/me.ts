import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import { getUserProfile, isPremium, updateUserProfile } from "@quickcal-cf/db";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { rateLimit } from "../middleware/rate-limit";

const app = new OpenAPIHono<AuthEnv>();
app.use(requireAuth);
app.use(rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "me:user" }));

const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phoneNumber: z.string().nullable(),
  isOnboarded: z.boolean(),
  isPremium: z.boolean(),
});

const getMe = createRoute({
  method: "get",
  path: "/me",
  tags: ["User"],
  summary: "Current profile, contact info, and premium status",
  responses: {
    [HttpStatusCodes.OK]: jsonContent(profileSchema, "Your profile"),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      z.object({ message: z.string() }),
      "Profile not found",
    ),
  },
});

app.openapi(getMe, async (c) => {
  const userId = c.get("userId");
  const db = getDb();
  const [profile, premium] = await Promise.all([
    getUserProfile(db, userId),
    isPremium(db, userId),
  ]);
  if (!profile) {
    return c.json(
      { message: "Profile not found" },
      HttpStatusCodes.NOT_FOUND,
    );
  }
  return c.json(
    { id: userId, ...profile, isPremium: premium },
    HttpStatusCodes.OK,
  );
});

const updateMeBody = z.object({
  phoneNumber: z.string().trim().max(32).optional(),
  isOnboarded: z.boolean().optional(),
});

const updateMe = createRoute({
  method: "patch",
  path: "/me",
  tags: ["User"],
  summary: "Update contact info / onboarding flag",
  request: { body: jsonContentRequired(updateMeBody, "Fields to update") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(profileSchema, "Updated profile"),
  },
});

app.openapi(updateMe, async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");
  const db = getDb();

  await updateUserProfile(db, userId, {
    ...(body.phoneNumber !== undefined ? { phoneNumber: body.phoneNumber } : {}),
    ...(body.isOnboarded !== undefined ? { isOnboarded: body.isOnboarded } : {}),
  });

  const [profile, premium] = await Promise.all([
    getUserProfile(db, userId),
    isPremium(db, userId),
  ]);
  return c.json({ id: userId, ...profile!, isPremium: premium }, HttpStatusCodes.OK);
});

export default app;
