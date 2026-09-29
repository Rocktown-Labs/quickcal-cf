import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../index";
import { apiKeys } from "../schema";

export const API_KEY_PREFIX = "qc_";
const PREFIX_LOOKUP_LENGTH = 11; // "qc_" + 8 chars

export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const encoded = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${API_KEY_PREFIX}${encoded}`;
}

export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createApiKeyRecord(
  db: Database,
  input: {
    userId: string;
    name: string;
    expiresAt?: Date | null;
  },
) {
  const key = generateApiKey();
  const result = await db
    .insert(apiKeys)
    .values({
      id: crypto.randomUUID(),
      name: input.name,
      keyPrefix: key.slice(0, PREFIX_LOOKUP_LENGTH),
      keyHash: await hashApiKey(key),
      userId: input.userId,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    });

  if (!result[0]) {
    throw new Error("Failed to create API key");
  }

  // Plaintext key is only available here — it cannot be recovered later.
  return { key, record: result[0] };
}

export async function verifyApiKey(db: Database, key: string) {
  if (!key.startsWith(API_KEY_PREFIX)) return null;

  const candidates = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyPrefix, key.slice(0, PREFIX_LOOKUP_LENGTH)));

  const hash = await hashApiKey(key);
  const now = new Date();

  for (const candidate of candidates) {
    if (candidate.keyHash !== hash) continue;
    if (candidate.expiresAt && candidate.expiresAt < now) return null;
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, candidate.id));
    return candidate;
  }

  return null;
}

export async function listApiKeys(db: Database, userId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

export async function deleteApiKey(db: Database, userId: string, keyId: string) {
  return db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id });
}
