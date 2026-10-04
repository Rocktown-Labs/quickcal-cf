/**
 * GLM-OCR client — turns images and PDFs into markdown text.
 *
 * Hosted on Z.ai's layout-parsing API (model: `glm-ocr`, $0.03/M tokens):
 * 94.62 on OmniDocBench V1.5, reads the tables/handwriting our schedules are
 * made of, and accepts PDFs directly — which Clef cannot. A self-hosted
 * GLM-OCR (vLLM/SGLang, 0.9B params) can replace this endpoint later by
 * pointing ZAI_LAYOUT_PARSING_URL at an adapter with the same contract.
 */

export const DEFAULT_LAYOUT_PARSING_URL = "https://api.z.ai/api/paas/v4/layout_parsing";

// The hosted API accepts PDF, JPG, PNG (base64 or URL). Notably NOT WebP —
// WebP uploads (Android screenshots) get a clear, actionable error.
const OCR_SUPPORTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** Timeout: large PDFs legitimately take a while; the workflow retries on top. */
const OCR_TIMEOUT_MS = 120_000;

export class OcrError extends Error {}

export interface OcrConfig {
  apiKey: string | undefined;
  url: string | undefined;
}

function toBase64(data: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    bin += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return btoa(bin);
}

interface LayoutParsingResponse {
  md_results?: string;
  error?: { message?: string; code?: number };
}

/**
 * OCRs a document to markdown. Throws OcrError with a user-facing message —
 * the workflow surfaces it as the upload's failureReason.
 */
export async function ocrDocument(
  config: OcrConfig,
  data: Uint8Array,
  contentType: string,
): Promise<string> {
  if (contentType === "image/webp") {
    throw new OcrError(
      "WebP images aren't supported for AI extraction yet — export the image as PNG, JPG, or PDF.",
    );
  }
  if (!OCR_SUPPORTED_TYPES.has(contentType)) {
    throw new OcrError(`Unsupported document type for reading: ${contentType}`);
  }

  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new OcrError(
      "Document reading isn't configured on the server (ZAI_API_KEY missing) — set it up to extract from images and PDFs.",
    );
  }

  const url = config.url?.trim() || DEFAULT_LAYOUT_PARSING_URL;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "glm-ocr",
        file: `data:${contentType};base64,${toBase64(data)}`,
      }),
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new OcrError(`Document reading failed: ${cause}`);
  }

  if (!response.ok) {
    const detail = await response
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => "no body");
    throw new OcrError(`GLM-OCR responded ${response.status}: ${detail}`);
  }

  const payload = (await response.json().catch(() => null)) as
    | LayoutParsingResponse
    | null;
  const markdown = payload?.md_results?.trim();
  if (!markdown) {
    throw new OcrError(
      payload?.error?.message ?? "GLM-OCR returned no readable text.",
    );
  }
  return markdown;
}
