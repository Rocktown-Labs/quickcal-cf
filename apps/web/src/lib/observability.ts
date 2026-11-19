import * as Sentry from "@sentry/browser";
import {
  privateDataCollection,
  scrubEvent,
  scrubBreadcrumb,
  scrubLog,
  safePath,
} from "@quickcal-cf/observability";
import { ENV } from "../env.public";

const dsn = import.meta.env.PUBLIC_SENTRY_DSN;
// Auth/reset/share pages carry sensitive tokens; exclude their DOM from replay.
const sensitivePage =
  typeof window !== "undefined" &&
  /^\/(?:s\/|reset-password|verify-email|consent)/.test(window.location.pathname);
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.PROD ? "production" : "development",
    release: import.meta.env.PUBLIC_SENTRY_RELEASE || undefined,
    integrations: [
      Sentry.browserTracingIntegration(),
      ...(!sensitivePage
        ? [
            Sentry.replayIntegration({
              maskAllText: true,
              maskAllInputs: true,
              blockAllMedia: true,
            }),
          ]
        : []),
    ],
    tracesSampleRate: 0.2,
    tracePropagationTargets: [new URL(ENV.PUBLIC_SERVER_URL).origin],
    replaysSessionSampleRate: 0.05,
    replaysOnErrorSampleRate: 1,
    dataCollection: { ...privateDataCollection, httpBodies: [] },
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendLog: scrubLog,
    initialScope: { tags: { service: "quickcal-web-browser" } },
  });
}

// API failures are often caught to show an inline message, so capture 5xx here.
export function captureApiFailure(path: string, status: number): void {
  Sentry.captureException(new Error(`API request failed (${status})`), {
    tags: { endpoint: safePath(path), status },
  });
}
