import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import jsonContent from "stoker/openapi/helpers/json-content";
import { getDashboardStats, getRecentUploads } from "@quickcal-cf/db";
import { getDb } from "../services";
import { type AuthEnv } from "../lib/auth";
import { rateLimit } from "../middleware/rate-limit";

const app = new OpenAPIHono<AuthEnv>();
app.use(rateLimit({ windowMs: 60_000, maxRequests: 60, keyPrefix: "dashboard:user" }));

const getStats = createRoute({
  method: "get",
  path: "/stats",
  tags: ["Dashboard"],
  summary: "Upload and event totals plus recent activity",
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({
        totalUploads: z.number(),
        completedUploads: z.number(),
        totalEvents: z.number(),
        recentUploads: z.array(
          z.object({
            id: z.string(),
            fileName: z.string(),
            status: z.string(),
            failureReason: z.string().nullable(),
            createdAt: z.string(),
          }),
        ),
      }),
      "Dashboard stats",
    ),
  },
});

app.openapi(getStats, async (c) => {
  const userId = c.get("userId");
  const db = getDb();
  const [stats, recent] = await Promise.all([
    getDashboardStats(db, userId),
    getRecentUploads(db, userId, 5),
  ]);
  return c.json(
    {
      ...stats,
      recentUploads: recent.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
    },
    HttpStatusCodes.OK,
  );
});

export default app;
