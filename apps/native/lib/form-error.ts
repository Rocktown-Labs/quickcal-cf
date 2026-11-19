/** Walks a TanStack Form / Better-Auth error object and finds a message. */
export function getErrorMessage(error: unknown, depth = 0): string | null {
  if (!error || depth > 10) return null;
  if (typeof error === "string") return error;
  if (Array.isArray(error)) {
    for (const issue of error) {
      const message = getErrorMessage(issue, depth + 1);
      if (message) return message;
    }
    return null;
  }
  if (typeof error === "object") {
    const maybeError = error as { message?: unknown };
    if (typeof maybeError.message === "string") return maybeError.message;
  }
  return null;
}
