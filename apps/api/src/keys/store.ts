import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { providers, userApiKeys, type Provider } from "../db/schema.js";
import { decrypt, encrypt } from "./crypto.js";

/** A saved key without its secret: the contract's UserKey. */
export interface KeySummary {
  providerId: string;
  last4: string;
  createdAt: Date;
  updatedAt: Date;
}

const summary = {
  providerId: userApiKeys.providerId,
  last4: userApiKeys.last4,
  createdAt: userApiKeys.createdAt,
  updatedAt: userApiKeys.updatedAt,
};

// The ciphertext is bound to its owner and provider, so a row copied to another user or
// provider fails to decrypt instead of handing over someone else's key.
const aadFor = (userId: string, providerId: string) => `caseguard:user-key:${userId}:${providerId}`;

export async function findProvider(db: Db, id: string): Promise<Provider | undefined> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id));
  return row;
}

/** The user's saved keys, ordered by provider id, including keys for disabled providers. */
export function listKeys(db: Db, userId: string): Promise<KeySummary[]> {
  return db
    .select(summary)
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId))
    .orderBy(asc(userApiKeys.providerId));
}

/** Saves or replaces the user's key for a provider, encrypted under `encryptionKey`. */
export async function upsertKey(
  db: Db,
  userId: string,
  providerId: string,
  apiKey: string,
  encryptionKey: Buffer,
): Promise<KeySummary> {
  const sealed = encrypt(apiKey, encryptionKey, aadFor(userId, providerId));
  const values = { ...sealed, last4: apiKey.slice(-4) };
  const [row] = await db
    .insert(userApiKeys)
    .values({ userId, providerId, ...values })
    .onConflictDoUpdate({
      target: [userApiKeys.userId, userApiKeys.providerId],
      set: { ...values, updatedAt: sql`now()` },
    })
    .returning(summary);
  return row!;
}

/** Deletes the user's key for a provider. Returns false if there was none. */
export async function deleteKey(db: Db, userId: string, providerId: string): Promise<boolean> {
  const rows = await db
    .delete(userApiKeys)
    .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.providerId, providerId)))
    .returning({ providerId: userApiKeys.providerId });
  return rows.length > 0;
}

/** The user's plaintext key for a provider, or undefined if none is saved. Throws if unreadable. */
export async function getDecrypted(
  db: Db,
  userId: string,
  providerId: string,
  encryptionKey: Buffer,
): Promise<string | undefined> {
  const [row] = await db
    .select({
      ciphertext: userApiKeys.ciphertext,
      iv: userApiKeys.iv,
      authTag: userApiKeys.authTag,
    })
    .from(userApiKeys)
    .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.providerId, providerId)));
  return row ? decrypt(row, encryptionKey, aadFor(userId, providerId)) : undefined;
}
