/**
 * Client-side PDF handling for the uploader.
 *
 * Two kinds of PDFs exist, and they need different pipelines:
 * - Digital PDFs have a text layer. They upload as-is; the server reads the
 *   text with unpdf (exact characters, no OCR errors possible).
 * - Scanned PDFs are photographs of pages with no text layer. The server
 *   can't read those, so we rasterize the pages to images right here in the
 *   browser (pdf.js → canvas → JPEG) and upload the image instead — the
 *   server then takes the normal GLM vision path.
 *
 * Returns the file to upload:
 * - null  → upload the original PDF (text layer present, or pdf.js couldn't
 *           open it and the server should surface its own error)
 * - File  → upload this rendered page image instead (scanned PDF)
 */
import type * as PdfJsLib from "pdfjs-dist";

const TEXT_PAGES_LIMIT = 10;
const RENDER_PAGES_LIMIT = 8;
/** Fewer alphanumeric characters than this across the doc ≈ no text layer. */
const MIN_TEXT_CHARS = 40;
/** Target rendered page width in px (letter pages are 612pt wide at scale 1). */
const TARGET_WIDTH = 1100;
const MAX_SCALE = 2.5;
const MAX_STITCHED_HEIGHT = 8000;
const JPEG_QUALITY = 0.82;

let libPromise: Promise<typeof PdfJsLib> | null = null;

async function loadPdfLib(): Promise<typeof PdfJsLib> {
  libPromise ??= (async () => {
    const lib = await import("pdfjs-dist");
    const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    lib.GlobalWorkerOptions.workerSrc = worker;
    return lib;
  })();
  return libPromise;
}

function hasTextLayer(text: string): boolean {
  return (text.match(/[a-z0-9]/gi) ?? []).length >= MIN_TEXT_CHARS;
}

async function extractText(doc: PdfJsLib.PDFDocumentProxy, pageLimit: number): Promise<string> {
  const parts: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, pageLimit); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return parts.join("\n");
}

function canvasToJpegFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not export the rendered PDF page."));
          return;
        }
        resolve(new File([blob], name, { type: "image/jpeg" }));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

/** Renders up to `pageLimit` pages and stitches them vertically into one JPEG. */
async function renderStitchedJpeg(
  doc: PdfJsLib.PDFDocumentProxy,
  pageLimit: number,
  name: string,
): Promise<File> {
  const pageCount = Math.min(doc.numPages, pageLimit);
  const pageCanvases: HTMLCanvasElement[] = [];
  let width = 0;
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_WIDTH / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available in this browser.");
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    pageCanvases.push(canvas);
    width = Math.max(width, canvas.width);
  }

  const gap = Math.round(width * 0.02);
  const rawHeight =
    pageCanvases.reduce((sum, c) => sum + c.height, 0) + gap * (pageCanvases.length - 1);
  // Scale the whole strip down if it would exceed the height cap.
  const shrink = rawHeight > MAX_STITCHED_HEIGHT ? MAX_STITCHED_HEIGHT / rawHeight : 1;
  const finalWidth = Math.round(width * shrink);

  const stitched = document.createElement("canvas");
  stitched.width = finalWidth;
  stitched.height = Math.round(rawHeight * shrink);
  const ctx = stitched.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available in this browser.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, stitched.width, stitched.height);

  let y = 0;
  for (const pageCanvas of pageCanvases) {
    ctx.drawImage(
      pageCanvas,
      0,
      y,
      Math.round(pageCanvas.width * shrink),
      Math.round(pageCanvas.height * shrink),
    );
    y += Math.round(pageCanvas.height * shrink) + Math.round(gap * shrink);
  }

  return canvasToJpegFile(stitched, name);
}

export async function preparePdfForUpload(file: File): Promise<File | null> {
  try {
    const pdfjs = await loadPdfLib();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;

    const text = await extractText(doc, TEXT_PAGES_LIMIT);
    if (hasTextLayer(text)) return null; // digital PDF — server reads it exactly

    const baseName = file.name.replace(/\.pdf$/i, "") || "document";
    return await renderStitchedJpeg(doc, RENDER_PAGES_LIMIT, `${baseName}.jpg`);
  } catch (err) {
    // Can't open or render? Fall back to the original file — the server's
    // pipeline produces the most accurate error message for it.
    console.warn("PDF preparation fell back to the original file:", err);
    return null;
  }
}
