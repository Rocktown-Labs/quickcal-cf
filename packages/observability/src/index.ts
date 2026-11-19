import type { Breadcrumb, Event, Log } from "@sentry/core";

export const privateDataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
};

/** Pages whose URLs/DOM can contain tokens; exclude them from replay/analytics. */
export function isSensitivePage(pathname: string): boolean {
  return /^\/(?:s\/|reset-password|verify-email|consent)/.test(pathname);
}

export const SENTRY_TRACES_SAMPLE_RATE = 0.2;

export function safePath(value: string): string {
  return value
    .split(/[?#]/)[0]!
    .replace(/(\/s\/)[^/]+/g, "$1[redacted]")
    .replace(/(\/api\/(?:share|calendar)\/)[^/]+/g, "$1[redacted]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[id]")
    .replace(/\buser_[a-zA-Z0-9]+\b/g, "[id]");
}

function safeText(value: string): string {
  return (
    value
      .replace(/https?:\/\/[^\s"'<>]+/g, safePath)
      .replace(/(\/s\/)[^/?#\s]+/g, "$1[redacted]")
      .replace(/(\/api\/(?:share|calendar)\/)[^/?#\s]+/g, "$1[redacted]")
      // Redact query parameter values in relative paths and any leftover URLs.
      .replace(/([?&][^=\s&#"'<>]+)=([^&\s#"'<>]*)/g, "$1=[redacted]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      .replace(/\b(?:qc_|sk_live_|sk_test_|re_)[a-zA-Z0-9_-]+/g, "[secret]")
      .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
  );
}

const sensitiveKey =
  /(?:authorization|cookie|token|password|secret|email|phone|user[_.]?id|file[_.]?name|storage[_.]?key|prompt|completion|source[_.]?text|db\.statement|db\.query\.text)/i;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function clean(value: unknown, depth = 0): unknown {
  if (depth > 12) return null;
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map((entry) => clean(entry, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeText(value.message),
      stack: value.stack ? safeText(value.stack) : undefined,
    };
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), clean(entry, depth + 1)]),
    );
  }
  if (value instanceof Set) return [...value].map((entry) => clean(entry, depth + 1));
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength}]`;
  if (value && typeof value === "object") {
    // Rebuilding class instances with Object.fromEntries would silently turn
    // them into `{}`; keep their string form instead.
    if (!isPlainObject(value)) return String(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitiveKey.test(key) ? "[redacted]" : clean(entry, depth + 1),
      ]),
    );
  }
  return value;
}

export function scrubEvent<T extends Event>(event: T): T {
  const result = clean(event) as T;
  delete result.user;
  if (result.request) {
    delete result.request.data;
    delete result.request.cookies;
    delete result.request.headers;
    delete result.request.query_string;
    if (result.request.url) result.request.url = safePath(result.request.url);
  }
  return result;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console" || breadcrumb.category === "ui.input") return null;
  return clean(breadcrumb) as Breadcrumb;
}

export function scrubLog(log: Log): Log {
  return clean(log) as Log;
}
