import {
  generateICSFromRows,
  getUploadById,
  getUploadEventsForReview,
  updateUploadRecord,
  type Database,
} from "@quickcal-cf/db";

/** Minimal R2 surface needed to keep the public .ics in sync. */
export interface IcsFiles {
  put(
    key: string,
    data: string | Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/**
 * Regenerates an upload's public .ics from the current event rows after an
 * edit or delete. Editing must never leave the shared file stale.
 *
 * If the last event is deleted, the .ics object and share token are removed
 * and the upload becomes `no_events`, so a previously shared link cannot keep
 * serving an event the owner deleted.
 *
 * This lives outside the REST route because the MCP tools mutate events too;
 * both transports must run the same refresh.
 */
export async function refreshUploadIcs(
  db: Database,
  files: IcsFiles,
  userId: string,
  uploadId: string,
): Promise<void> {
  const upload = await getUploadById(db, uploadId);
  if (!upload || upload.userId !== userId) return;

  const rows = await getUploadEventsForReview(db, userId, uploadId);

  // Last event removed → the calendar file and share link go with it.
  if (rows.length === 0) {
    if (upload.icsKey) {
      await files.delete(upload.icsKey).catch(() => undefined);
    }
    await updateUploadRecord(db, uploadId, {
      icsKey: null,
      shareToken: null,
      status: "no_events",
      failureReason: null,
    });
    return;
  }

  if (!upload.icsKey) return;

  const icsContent = generateICSFromRows(rows);
  await files.put(upload.icsKey, icsContent, {
    httpMetadata: { contentType: "text/calendar" },
  });
}
