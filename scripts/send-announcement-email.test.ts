import { describe, expect, test } from "bun:test";
import { ANNOUNCEMENT_PREVIEW, ANNOUNCEMENT_SUBJECT, renderAnnouncementEmail } from "../packages/email/src/index";

describe("Announcement Email", () => {
  test("renders valid html and text without em dashes", async () => {
    const { html, text } = await renderAnnouncementEmail({
      firstName: "Taylor",
      senderName: "Rocktown Labs",
      loginUrl: "https://quickcalai.com/login",
      unsubscribeUrl: "mailto:unsubscribe@quickcalai.com",
    });

    expect(html).toContain("QuickCalAI");
    expect(html).toContain("Hey Taylor,");
    expect(html).toContain("Open the new QuickCalAI");
    expect(html).toContain("https://quickcalai.com/login");
    expect(html).not.toContain("—");

    expect(text).toContain("Hey Taylor,");
    expect(text).not.toContain("—");
    expect(ANNOUNCEMENT_SUBJECT).not.toContain("—");
    expect(ANNOUNCEMENT_PREVIEW).not.toContain("—");
  });
});
