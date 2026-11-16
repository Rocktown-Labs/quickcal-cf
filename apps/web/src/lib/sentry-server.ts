import * as Sentry from "@sentry/cloudflare";
import {
  privateDataCollection,
  scrubEvent,
  scrubBreadcrumb,
  scrubLog,
} from "@quickcal-cf/observability";

export function webSentryOptions(env: {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
}): Sentry.CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN || undefined,
    enabled: Boolean(env.SENTRY_DSN),
    release: env.SENTRY_RELEASE || undefined,
    environment: "production",
    tracesSampleRate: 0.2,
    dataCollection: { ...privateDataCollection, httpBodies: [] },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendLog: scrubLog,
    initialScope: { tags: { service: "quickcal-web-ssr" } },
  };
}
