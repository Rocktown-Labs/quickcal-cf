import { ENV } from "./env.server";
import { type Database, createDb } from "@quickcal-cf/db";
import { createAuth as createConfiguredAuth } from "@quickcal-cf/auth";

export function getDb(): Database {
  return createDb(ENV);
}
export async function createAuth(database?: Database) {
  return createConfiguredAuth(ENV, database ?? await getDb());
}
