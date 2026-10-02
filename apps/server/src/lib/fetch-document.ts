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

/**
 * Guards for URL ingestion. Cloudflare Workers have no RFC1918 egress, so
 * private-network SSRF is structurally blocked at the platform level — these
 * checks stop the remaining foot-guns before we spend a fetch:
 * explicit-credential URLs, odd ports, and loopback hostnames.
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
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
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
  const url = assertFetchableUrl(rawUrl);

  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "QuickCalAI-Ingest/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => {
    throw new IngestUrlError("Could not reach that URL.", 502);
  });

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

  const fileName =
    decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "") || "fetched-document";

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
