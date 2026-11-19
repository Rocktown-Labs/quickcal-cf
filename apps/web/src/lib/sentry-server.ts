import * as Sentry from "@sentry/cloudflare";
import {
  privateDataCollection,
  SENTRY_TRACES_SAMPLE_RATE,
  scrubEvent,
  scrubBreadcrumb,
  scrubLog,
} from "@quickcal-cf/observability";

export function webSentryOptions(env: {
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  NODE_ENV?: string;
}): Sentry.CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN || undefined,
    enabled: Boolean(env.SENTRY_DSN),
    release: env.SENTRY_RELEASE || undefined,
    environment: env.NODE_ENV ?? "production",
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    dataCollection: { ...privateDataCollection, httpBodies: [] },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendLog: scrubLog,
    initialScope: { tags: { service: "quickcal-web-ssr" } },
  };
}
