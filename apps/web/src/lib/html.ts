/**
 * Escapes a string for safe interpolation into innerHTML text content.
 * Use for any user- or AI-controlled value rendered via innerHTML.
 */
export function escapeHtml(value: string | null | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
