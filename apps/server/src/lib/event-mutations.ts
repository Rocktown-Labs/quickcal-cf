import { deleteUserEvent, updateUserEvent, type Database, type EventPatch } from "@quickcal-cf/db";
import { refreshUploadIcs, type IcsFiles } from "./refresh-ics";

/**
 * Owner-scoped event mutations that also keep the public .ics in sync.
 *
 * Both the REST routes and the MCP tools use these helpers. Before they were
 * shared, the MCP path updated/deleted rows but never regenerated the share
 * artifact — a deleted event stayed visible in a previously shared .ics.
 */
export async function updateEventAndRefreshIcs(
  db: Database,
  files: IcsFiles,
  userId: string,
  eventId: string,
  patch: EventPatch,
) {
  const updated = await updateUserEvent(db, userId, eventId, patch);
  if (updated?.uploadId) {
    await refreshUploadIcs(db, files, userId, updated.uploadId);
  }
  return updated;
}

export async function deleteEventAndRefreshIcs(
  db: Database,
  files: IcsFiles,
  userId: string,
  eventId: string,
) {
  const deleted = await deleteUserEvent(db, userId, eventId);
  if (deleted?.uploadId) {
    await refreshUploadIcs(db, files, userId, deleted.uploadId);
  }
  return deleted;
}
