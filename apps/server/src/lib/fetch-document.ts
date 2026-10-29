import { detectMimeType } from "./validators";

export class IngestUrlError extends Error {
  status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.status = status;
  }
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;

/** Content types that flow into the text-extraction pipeline. */
export const TEXT_CONTENT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);

function ipv4IsPrivate(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 || // RFC1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

function hostIsInternal(rawHostname: string): boolean {
  // Trailing dots are a valid FQDN form that resolvers accept
  // (`localhost.` → 127.0.0.1), so strip them before matching.
  const host = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  // IPv4 (WHATWG URL normalizes decimal/octal/hex forms to dotted quad).
  if (ipv4IsPrivate(host)) return true;

  // IPv6 loopback, unspecified, IPv4-mapped, unique-local, and link-local.
  if (host === "::1" || host === "::") return true;
  if (host.startsWith("::ffff:")) {
    const mapped = host.slice("::ffff:".length);
    if (ipv4IsPrivate(mapped)) return true;
    // Node/Bun may render the mapped address as two hex groups (7f00:1).
    if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(mapped)) {
      const [hi, lo] = mapped.split(":").map((part) => parseInt(part!, 16));
      if (hi !== undefined && lo !== undefined) {
        const a = (hi >> 8) & 0xff;
        const b = hi & 0xff;
        const c = (lo >> 8) & 0xff;
        const d = lo & 0xff;
        if (ipv4IsPrivate(`${a}.${b}.${c}.${d}`)) return true;
      }
    }
  }
  if (/^f[cd][0-9a-f]{0,2}:/.test(host)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]?:/.test(host)) return true; // fe80::/10 link-local

  return false;
}

/**
 * Guards for URL ingestion. Cloudflare Workers have no RFC1918 egress, so
 * private-network SSRF is structurally blocked at the platform level — these
 * checks stop the remaining foot-guns before we spend a fetch:
 * explicit-credential URLs, odd ports, loopback/private hosts, and plain
 * HTTP. Redirect targets are re-validated by `fetchIngestDocument`.
 */
export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IngestUrlError("That doesn't look like a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new IngestUrlError("Only http(s) URLs can be ingested.");
  }
  if (url.username || url.password) {
    throw new IngestUrlError("URLs with embedded credentials are not accepted.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new IngestUrlError("Only ports 80 and 443 can be ingested.");
  }
  if (hostIsInternal(url.hostname)) {
    throw new IngestUrlError("Internal addresses cannot be ingested.");
  }
  if (url.protocol === "http:") {
    throw new IngestUrlError("Insecure http:// URLs are not accepted — use https://.");
  }

  return url;
}

export interface FetchedDocument {
  contentType: string;
  bytes: Uint8Array;
  text: string | null;
  fileName: string;
}

/**
 * Fetches an ingest target with timeout + size caps. Images/PDFs are
 * magic-byte validated (same rule as file uploads); allow-listed text types
 * are returned as text. `Content-Length` lies are caught by capping the
 * streamed read.
 */
export async function fetchIngestDocument(rawUrl: string): Promise<FetchedDocument> {
  let url = assertFetchableUrl(rawUrl);
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  // Follow redirects manually: `redirect: "follow"` would re-fetch whatever
  // the target points at without re-running the SSRF guards, letting a public
  // URL bounce to http:// or an internal address. Every hop is validated.
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  const maxRedirects = 5;
  let res: Response;
  for (let redirects = 0; ; redirects += 1) {
    res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "QuickCalAI-Ingest/1.0" },
      signal,
    }).catch(() => {
      throw new IngestUrlError("Could not reach that URL.", 502);
    });

    if (!redirectStatuses.has(res.status)) break;

    if (redirects >= maxRedirects) {
      await res.body?.cancel().catch(() => undefined);
      throw new IngestUrlError("That URL redirected too many times.");
    }

    const location = res.headers.get("location");
    if (!location) {
      await res.body?.cancel().catch(() => undefined);
      throw new IngestUrlError("That URL returned an invalid redirect.");
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      await res.body?.cancel().catch(() => undefined);
      throw new IngestUrlError("That URL returned an invalid redirect.");
    }
    url = assertFetchableUrl(next.toString());
    await res.body?.cancel().catch(() => undefined);
  }

  if (res.url && res.url !== url.toString()) {
    // Defensive: a runtime that still followed the redirect must not slip an
    // unvalidated final URL past the guards.
    assertFetchableUrl(res.url);
  }

  if (!res.ok) {
    throw new IngestUrlError(`The URL responded with ${res.status}.`, 502);
  }
  if (!res.body) {
    throw new IngestUrlError("The URL returned an empty response.");
  }

  const declaredLength = Number(res.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_CONTENT_BYTES) {
    throw new IngestUrlError("The document exceeds the 10MB limit.");
  }

  // Cap the streamed read so lying/missing Content-Length can't OOM us.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > MAX_CONTENT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new IngestUrlError("The document exceeds the 10MB limit.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let fileName = "fetched-document";
  try {
    fileName =
      decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "") || "fetched-document";
  } catch {
    // Malformed percent-encoding in the path — keep the safe default.
  }

  const declaredType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";

  // Images and PDFs: trust bytes, never headers — same rule as file uploads.
  const sniffed = detectMimeType(bytes);
  if (sniffed) {
    return { contentType: sniffed, bytes, text: null, fileName };
  }

  if (declaredType && TEXT_CONTENT_TYPES.has(declaredType)) {
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) {
      throw new IngestUrlError("The document is empty.");
    }
    return { contentType: declaredType, bytes, text, fileName };
  }

  if (declaredType === "text/html") {
    throw new IngestUrlError(
      "That URL points to an HTML page. Use the page's direct image/PDF link instead.",
    );
  }

  throw new IngestUrlError(
    "That URL points to an unsupported content type. Supported: JPEG, PNG, WebP, PDF, plain text, Markdown, CSV.",
  );
}
