/** Normalize and validate an absolute API origin (shared by api/auth clients). */
export function normalizeBaseUrl(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`${name} must be an absolute http(s) URL`);
  }
  return trimmed;
}
