import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sentryRollupPlugin } from "@sentry/rollup-plugin";
import { fileURLToPath } from "node:url";
import { RuntimeBuildPlugin } from "./runtime-plugin";
import "varlock/auto-load";

// Optional custom-domain wiring. The zone must already be active in the
// Cloudflare account; leave these unset for the workers.dev deployment.
const serverCustomDomain = process.env.SERVER_CUSTOM_DOMAIN?.trim() || undefined;
const webCustomDomain = process.env.WEB_CUSTOM_DOMAIN?.trim() || undefined;
// When the API is served from a custom domain, the auth issuer and the web
// bundle's API base must use it instead of the workers.dev URL.
const configuredAuthUrl = process.env.BETTER_AUTH_URL?.trim() || undefined;
const configuredPublicServerUrl = process.env.PUBLIC_SERVER_URL?.trim() || undefined;
const sentryBuildConfigured = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);
const observability = {
  enabled: true,
  headSamplingRate: 1,
  redactQueryString: true,
  logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
  traces: { enabled: true, headSamplingRate: 0.2, persist: true },
};

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
  ...(serverCustomDomain ? { domain: serverCustomDomain } : {}),
  compatibility: {
    flags: ["nodejs_compat"],
  },
  observability,
  build: {
    output: {
      // Rolldown resolves relative output paths from the server package, while
      // Sentry scans from the infra process directory. Give both the same path.
      dir: fileURLToPath(
        new URL("../../apps/server/.alchemy/bundles/server/", import.meta.url).href,
      ),
      plugins: sentryBuildConfigured
        ? sentryRollupPlugin({
            authToken: process.env.SENTRY_AUTH_TOKEN,
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            release: { name: process.env.SENTRY_RELEASE, create: false, finalize: false },
            telemetry: false,
          }).map((plugin: Record<string, unknown>) => {
            // Alchemy exposes Rolldown's output hooks. buildStart only sends the
            // plugin's own telemetry; renderChunk/writeBundle do map injection/upload.
            const { buildStart: _buildStart, transform: _transform, ...outputPlugin } = plugin;
            return new RuntimeBuildPlugin(outputPlugin);
          })
        : [],
    },
  },
  env: {
    NODE_ENV: Config.withDefault(Config.String("NODE_ENV"), "production"),
    SENTRY_DSN: Config.withDefault(Config.String("SENTRY_DSN"), ""),
    SENTRY_RELEASE: Config.withDefault(Config.String("SENTRY_RELEASE"), ""),
    DB: db,
    FILES: files,
    CALENDAR_WORKFLOW: calendarWorkflow,
    AI: Cloudflare.Workers.AI(),
    RATE_LIMITER: Cloudflare.DurableObject("RATE_LIMITER", {
      className: "RateLimiter",
    }),
    CORS_ORIGIN: Config.String("CORS_ORIGIN"),
    BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
    BETTER_AUTH_URL: configuredAuthUrl ?? Cloudflare.Worker.URL,
    GOOGLE_CLIENT_ID: Config.withDefault(Config.String("GOOGLE_CLIENT_ID"), ""),
    GOOGLE_CLIENT_SECRET: Config.withDefault(Config.Redacted("GOOGLE_CLIENT_SECRET"), ""),
    GOOGLE_IOS_CLIENT_ID: Config.withDefault(Config.String("GOOGLE_IOS_CLIENT_ID"), ""),
    ADMIN_USER_IDS: Config.withDefault(Config.String("ADMIN_USER_IDS"), ""),
    STRIPE_SECRET_KEY: Config.withDefault(Config.Redacted("STRIPE_SECRET_KEY"), ""),
    STRIPE_WEBHOOK_SECRET: Config.withDefault(Config.Redacted("STRIPE_WEBHOOK_SECRET"), ""),
    STRIPE_PREMIUM_PRICE_ID: Config.withDefault(Config.String("STRIPE_PREMIUM_PRICE_ID"), ""),
    STRIPE_PREMIUM_ANNUAL_PRICE_ID: Config.withDefault(
      Config.String("STRIPE_PREMIUM_ANNUAL_PRICE_ID"),
      "",
    ),
    // Event extraction runs in-network on Workers AI (GLM flash family).
    EXTRACTION_MODEL: Config.withDefault(
      Config.String("EXTRACTION_MODEL"),
      "@cf/zai-org/glm-5.3-flash",
    ),
    RESEND_API_KEY: Config.withDefault(Config.Redacted("RESEND_API_KEY"), ""),
    RESEND_FROM_EMAIL: Config.withDefault(Config.String("RESEND_FROM_EMAIL"), ""),
    SENT_DM_API_KEY: Config.withDefault(Config.Redacted("SENT_DM_API_KEY"), ""),
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
      compatibility: { flags: ["nodejs_compat"] },
      observability,
      ...(webCustomDomain
        ? { domain: { name: webCustomDomain, aliases: [`www.${webCustomDomain}`] } }
        : {}),
      env: {
        SESSION: Cloudflare.KV.Namespace("session"),
        IMAGES: Cloudflare.Images.Images(),
        PUBLIC_SERVER_URL: configuredPublicServerUrl ?? serverWorker.url.as<string>(),
        PUBLIC_SENTRY_DSN: Config.withDefault(Config.String("SENTRY_DSN"), ""),
        PUBLIC_SENTRY_RELEASE: Config.withDefault(Config.String("SENTRY_RELEASE"), ""),
        SENTRY_DSN: Config.withDefault(Config.String("SENTRY_DSN"), ""),
        SENTRY_RELEASE: Config.withDefault(Config.String("SENTRY_RELEASE"), ""),
        CANONICAL_WEB_ORIGIN: webCustomDomain ? `https://${webCustomDomain}` : "",
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
