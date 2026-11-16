import { describe, expect, test } from "bun:test";
import { safePath, scrubBreadcrumb, scrubEvent, scrubLog } from "./index";

describe("telemetry privacy", () => {
  test("removes auth, email, request content, and share/feed secrets", () => {
    const event = scrubEvent({
      user: { id: "private-user", email: "person@example.com" },
      request: {
        url: "https://quickcalai.com/reset-password?token=private",
        headers: { Cookie: "private" },
        data: { password: "private" },
      },
      extra: {
        authorization: "Bearer private",
        sourceText: "private calendar",
        fileName: "private.pdf",
      },
      exception: {
        values: [
          {
            value:
              "Request https://quickcalai.com/s/private-token?email=person@example.com failed for person@example.com",
          },
        ],
      },
    });
    const encoded = JSON.stringify(event);
    expect(encoded).not.toContain("person@example.com");
    expect(encoded).not.toContain("private-user");
    expect(encoded).not.toContain("private-token");
    expect(encoded).not.toContain("private calendar");
    expect(event.request?.url).toBe("https://quickcalai.com/reset-password");
    expect(event.request?.headers).toBeUndefined();
    expect(safePath("/api/calendar/feed-secret?token=abc")).toBe("/api/calendar/[redacted]");
  });

  test("keeps useful operational attributes and scrubs logs/breadcrumbs", () => {
    expect(
      scrubLog({
        level: "error",
        message: "API failed",
        attributes: { status: 500, route: "/api/uploads/:id", email: "person@example.com" },
      }),
    ).toEqual({
      level: "error",
      message: "API failed",
      attributes: { status: 500, route: "/api/uploads/:id", email: "[redacted]" },
    });
    expect(scrubBreadcrumb({ category: "console", message: "private document" })).toBeNull();
    expect(
      scrubBreadcrumb({ category: "fetch", data: { url: "https://example.com/api?token=secret" } })
        ?.data?.url,
    ).toBe("https://example.com/api");
  });
});
