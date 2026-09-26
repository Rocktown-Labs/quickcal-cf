import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import jsonContentRequired from "stoker/openapi/helpers/json-content-required";
import createMessageObjectSchema from "stoker/openapi/schemas/create-message-object";
import { getUploadById, getUploadEventCount } from "@quickcal-cf/db";
import { ENV } from "../env.server";
import { getDb } from "../services";
import { requireAuth, type AuthEnv } from "../lib/auth";
import { isPremium } from "../lib/premium";
import {
  NotificationConfigurationError,
  NotificationInputError,
  sendCalendarFileEmail,
  sendCalendarFileSms,
} from "../lib/notifications";

const app = new OpenAPIHono<AuthEnv>();
app.use(requireAuth);

const idParams = z.object({ id: z.string().uuid() });

const emailBody = z.object({ email: z.string().trim().email().max(320) });
const smsBody = z.object({ phone: z.string().trim().min(7).max(32) });

const deliveryResult = z.object({ message: z.string() });
const errorResponses = {
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    createMessageObjectSchema("Not found"),
    "Upload not found",
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    createMessageObjectSchema("Premium required"),
    "Email and SMS delivery are premium features",
  ),
  [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
    createMessageObjectSchema("Invalid input"),
    "Validation or configuration failed",
  ),
};

async function loadCompletedUpload(
  db: ReturnType<typeof getDb>,
  userId: string,
  uploadId: string,
) {
  const upload = await getUploadById(db, uploadId);
  if (!upload || upload.userId !== userId) return null;
  if (upload.status !== "completed" || !upload.icsKey || !upload.shareToken) return null;
  return upload;
}

function publicIcsUrl(shareToken: string): string {
  return `${ENV.BETTER_AUTH_URL}/api/share/${shareToken}/ics`;
}

function publicShareUrl(shareToken: string): string {
  const webOrigin =
    (ENV as unknown as Record<string, string | undefined>).PUBLIC_WEB_URL?.trim() ||
    "https://quickcal-web.rocktown-labs.workers.dev";
  return `${webOrigin}/s/${shareToken}`;
}

const sendEmail = createRoute({
  method: "post",
  path: "/{id}/email",
  tags: ["Delivery"],
  summary: "Email the .ics file (premium)",
  request: { params: idParams, body: jsonContentRequired(emailBody, "Destination email") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(deliveryResult, "Email queued"),
    ...errorResponses,
  },
});

app.openapi(sendEmail, async (c) => {
  const { id } = c.req.valid("param");
  const { email } = c.req.valid("json");
  const userId = c.get("userId");
  const db = getDb();

  if (!(await isPremium(db, userId))) {
    return c.json({ message: "Email delivery is a premium feature." }, HttpStatusCodes.FORBIDDEN);
  }

  const upload = await loadCompletedUpload(db, userId, id);
  if (!upload?.shareToken) {
    return c.json(
      { message: "File not found or not ready for sharing." },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  try {
    await sendCalendarFileEmail({
      uploadId: upload.id,
      userId,
      to: email,
      fileName: upload.fileName,
      icsUrl: publicIcsUrl(upload.shareToken),
      eventCount: await getUploadEventCount(db, upload.id),
      shareUrl: publicShareUrl(upload.shareToken),
    });
    return c.json({ message: `Calendar file sent to ${email}` }, HttpStatusCodes.OK);
  } catch (error) {
    if (error instanceof NotificationConfigurationError) {
      return c.json({ message: error.message }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
    }
    throw error;
  }
});

const sendSms = createRoute({
  method: "post",
  path: "/{id}/sms",
  tags: ["Delivery"],
  summary: "SMS the download link (premium)",
  request: { params: idParams, body: jsonContentRequired(smsBody, "Destination phone") },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(deliveryResult, "SMS queued"),
    ...errorResponses,
  },
});

app.openapi(sendSms, async (c) => {
  const { id } = c.req.valid("param");
  const { phone } = c.req.valid("json");
  const userId = c.get("userId");
  const db = getDb();

  if (!(await isPremium(db, userId))) {
    return c.json({ message: "SMS delivery is a premium feature." }, HttpStatusCodes.FORBIDDEN);
  }

  const upload = await loadCompletedUpload(db, userId, id);
  if (!upload?.shareToken) {
    return c.json(
      { message: "File not found or not ready for sharing." },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  try {
    await sendCalendarFileSms({
      uploadId: upload.id,
      userId,
      to: phone,
      icsUrl: publicIcsUrl(upload.shareToken),
    });
    return c.json({ message: `Download link sent to ${phone}` }, HttpStatusCodes.OK);
  } catch (error) {
    if (
      error instanceof NotificationConfigurationError ||
      error instanceof NotificationInputError
    ) {
      return c.json({ message: error.message }, HttpStatusCodes.UNPROCESSABLE_ENTITY);
    }
    throw error;
  }
});

export default app;
