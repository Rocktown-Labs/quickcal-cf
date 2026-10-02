import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import { ensureCalToken, getUserProfile, isPremium, updateUserProfile } from "@quickcal-cf/db";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { rateLimit } from "../middleware/rate-limit";
import { webhookSecretFor } from "../lib/webhook";
import { ENV } from "../env.server";

const app = new OpenAPIHono<AuthEnv>();
app.use(requireAuth);
app.use(rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "me:user" }));

const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  phoneNumber: z.string().nullable(),
  useCase: z.string().nullable(),
  calendarApp: z.string().nullable(),
  isOnboarded: z.boolean(),
  isPremium: z.boolean(),
  freeCredits: z.number(),
  calendarFeedPath: z.string().nullable(),
  webhookSecret: z.string(),
});

// Onboarding questionnaire answers — sent by the web app's /onboarding flow.
const useCaseSchema = z.enum(["class", "work", "conference", "events", "other"]);
const calendarAppSchema = z.enum(["google", "apple", "outlook", "other"]);

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
  const [profile, premium] = await Promise.all([getUserProfile(db, userId), isPremium(db, userId)]);
  if (!profile) {
    return c.json({ message: "Profile not found" }, HttpStatusCodes.NOT_FOUND);
  }
  const [calToken, webhookSecret] = await Promise.all([
    ensureCalToken(db, userId),
    webhookSecretFor(ENV.BETTER_AUTH_SECRET, userId),
  ]);
  return c.json(
    {
      id: userId,
      ...profile,
      isPremium: premium,
      calendarFeedPath: `/api/calendar/${calToken}`,
      webhookSecret,
    },
    HttpStatusCodes.OK,
  );
});

const updateMeBody = z.object({
  phoneNumber: z.string().trim().max(32).optional(),
  useCase: useCaseSchema.optional(),
  calendarApp: calendarAppSchema.optional(),
  isOnboarded: z.boolean().optional(),
});

const updateMe = createRoute({
  method: "patch",
  path: "/me",
  tags: ["User"],
  summary: "Update contact info / onboarding answers / onboarding flag",
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
    ...(body.useCase !== undefined ? { useCase: body.useCase } : {}),
    ...(body.calendarApp !== undefined ? { calendarApp: body.calendarApp } : {}),
    ...(body.isOnboarded !== undefined ? { isOnboarded: body.isOnboarded } : {}),
  });

  const [profile, premium] = await Promise.all([getUserProfile(db, userId), isPremium(db, userId)]);
  const [calToken, webhookSecret] = await Promise.all([
    ensureCalToken(db, userId),
    webhookSecretFor(ENV.BETTER_AUTH_SECRET, userId),
  ]);
  return c.json(
    {
      id: userId,
      ...profile!,
      isPremium: premium,
      calendarFeedPath: `/api/calendar/${calToken}`,
      webhookSecret,
    },
    HttpStatusCodes.OK,
  );
});

export default app;
