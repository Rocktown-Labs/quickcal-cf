/**
 * PDF text extraction via unpdf (serverless PDF.js build, Workers-compatible).
 *
 * Reads the text layer of a PDF — which covers itineraries, confirmations,
 * and other digitally-generated documents. Scanned/image-only PDFs have no
 * text layer; those surface a clear error telling the user to upload an
 * image instead. (Workers AI vision models accept images only, and the
 * previous external OCR service is gone.)
 */
import { extractText, getDocumentProxy } from "unpdf";

export class PdfTextError extends Error {}

export async function extractPdfText(data: Uint8Array): Promise<string> {
  let text: string | string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const result = await extractText(pdf, { mergePages: true });
    text = result.text;
  } catch (err) {
    throw new PdfTextError(
      `Couldn't read the PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const merged = (Array.isArray(text) ? text.join("\n\n") : text).trim();
  if (!merged) {
    throw new PdfTextError(
      "This PDF has no selectable text (it may be a scan or photos) — export or screenshot it as a PNG or JPG and upload that instead.",
    );
  }
  return merged;
}
