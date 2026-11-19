import { defineConfig } from "drizzle-kit";
import "varlock/auto-load";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const databaseId = process.env.CLOUDFLARE_DATABASE_ID?.trim();
const token = process.env.CLOUDFLARE_D1_TOKEN?.trim();

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./src/migrations",
  // DOCS: https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit
  dialect: "sqlite",
  driver: "d1-http",
  // Required only for `drizzle-kit migrate`; `generate` works offline.
  ...(accountId && databaseId && token ? { dbCredentials: { accountId, databaseId, token } } : {}),
});
