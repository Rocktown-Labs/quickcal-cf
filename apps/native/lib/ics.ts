import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { apiFetch } from "./api";

function slugify(name: string): string {
  const slug = name
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${slug || "calendar-events"}.ics`;
}

function writeCacheFile(fileName: string, content: string): string {
  // Unique suffix: concurrent shares must not clobber a file the share sheet
  // is still reading.
  const unique = `${slugify(fileName).replace(/\.ics$/, "")}-${Date.now().toString(36)}.ics`;
  const file = new File(Paths.cache, unique);
  file.create({ overwrite: true });
  file.write(content, { encoding: "utf8" });
  return file.uri;
}

async function shareFromCache(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing isn't available on this device.");
  }
  await Sharing.shareAsync(uri, {
    mimeType: "text/calendar",
    dialogTitle: "Your calendar file",
  });
}

/**
 * Fetches a public .ics share URL, writes it to the cache directory, and
 * opens the system share sheet — the native equivalent of the web's
 * "Download .ics" (the user can AirDrop, save to Files, or open it with
 * any installed calendar app).
 */
export async function downloadAndShareIcs(shareToken: string, fileName: string): Promise<void> {
  const res = await apiFetch(`/api/share/${encodeURIComponent(shareToken)}/ics`);
  if (!res.ok) {
    throw new Error("The calendar file is not available.");
  }
  const contentType = res.headers.get("content-type") ?? "";
  const content = await res.text();
  if (!contentType.includes("text/calendar") || !content.includes("BEGIN:VCALENDAR")) {
    throw new Error("The server returned an invalid calendar file.");
  }
  await shareFromCache(writeCacheFile(fileName, content));
}

/** Writes raw .ics content (manual events) to cache and opens the share sheet. */
export async function shareIcsContent(icsContent: string, fileName: string): Promise<void> {
  await shareFromCache(writeCacheFile(fileName, icsContent));
}
