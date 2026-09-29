import type { DatabaseConfig } from "./config";
import { relations } from "./relations";
import { drizzle } from "drizzle-orm/d1";

export function createDb(env: DatabaseConfig) {
	return drizzle(env.DB, { relations });
}

export type Database = ReturnType<typeof createDb>;

export * from "./schema";
export * from "./queries/uploads";
export * from "./queries/users";
export * from "./queries/apikeys";
export * from "./queries/billing";
export * from "./queries/plans";
export * from "./ics";
