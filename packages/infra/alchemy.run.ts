import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import "varlock/auto-load";


export const db = Cloudflare.D1.Database("database", {
  migrations: "../../packages/db/src/migrations",
});

export const files = Cloudflare.R2.Bucket("files", {
  name: "quickcalai-files",
});

export const calendarWorkflow = Cloudflare.Workflows.Workflow("calendar-workflow", {
  className: "CalendarProcessingWorkflow",
});

export const server = Cloudflare.Worker("server", {
  name: "quickcal-server",
  main: "../../apps/server/src/index.ts",
  compatibility: {
    flags: ["nodejs_compat"],
  },
  env: {
    DB: db,
    FILES: files,
    CALENDAR_WORKFLOW: calendarWorkflow,
    CORS_ORIGIN: Config.String("CORS_ORIGIN"),
    BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
    BETTER_AUTH_URL: Cloudflare.Worker.URL,
    GOOGLE_CLIENT_ID: Config.withDefault(Config.String("GOOGLE_CLIENT_ID"), ""),
    GOOGLE_CLIENT_SECRET: Config.withDefault(Config.Redacted("GOOGLE_CLIENT_SECRET"), ""),
    GOOGLE_IOS_CLIENT_ID: Config.withDefault(Config.String("GOOGLE_IOS_CLIENT_ID"), ""),
    ADMIN_USER_IDS: Config.withDefault(Config.String("ADMIN_USER_IDS"), ""),
    STRIPE_SECRET_KEY: Config.withDefault(Config.Redacted("STRIPE_SECRET_KEY"), ""),
    STRIPE_WEBHOOK_SECRET: Config.withDefault(Config.Redacted("STRIPE_WEBHOOK_SECRET"), ""),
    STRIPE_PREMIUM_PRICE_ID: Config.withDefault(Config.String("STRIPE_PREMIUM_PRICE_ID"), ""),
    STRIPE_PREMIUM_ANNUAL_PRICE_ID: Config.withDefault(Config.String("STRIPE_PREMIUM_ANNUAL_PRICE_ID"), ""),
    GOOGLE_GENERATIVE_AI_API_KEY: Config.Redacted("GOOGLE_GENERATIVE_AI_API_KEY"),
    RESEND_API_KEY: Config.Redacted("RESEND_API_KEY"),
    RESEND_FROM_EMAIL: Config.withDefault(Config.String("RESEND_FROM_EMAIL"), ""),
    SENT_DM_API_KEY: Config.Redacted("SENT_DM_API_KEY"),
  },
  dev: {
    port: 3000,
  },
});

export type ServerEnv = Cloudflare.InferEnv<typeof server>;


export default Alchemy.Stack(
  "quickcal-cf",
  {
    providers: Layer.mergeAll(Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const serverWorker = yield* server;
    const webWorker = yield* Cloudflare.Website.Astro("web", {
      name: "quickcal-web",
      rootDir: "../../apps/web",
      env: {
        SESSION: Cloudflare.KV.Namespace("session"),
        IMAGES: Cloudflare.Images.Images(),
        PUBLIC_SERVER_URL: serverWorker.url.as<string>(),
      },
      dev: {
        port: 4321,
      },
    });

    return {
      web: webWorker.url,
      server: serverWorker.url,
    };
  }),
);
