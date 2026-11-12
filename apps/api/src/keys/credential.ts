import { eq } from "drizzle-orm";
import type { Credential } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { findProvider, getDecrypted } from "./store.js";

/**
 * The credential to send with a question (FR-SET-2, SEC-11, ADR-0009): the user's defaultModel
 * and their decrypted key for its provider, but only if that provider is in this request's
 * allow-list, is a cloud provider, and has a saved key, and the api has an encryption key.
 * Otherwise undefined, and the deployment's own configuration answers. Throws only if a saved
 * key can't be decrypted. The result holds a secret: never log it or store it.
 */
export async function resolveCredential(
  db: Db,
  userId: string,
  allowedProviders: readonly string[],
  encryptionKey: Buffer | undefined,
): Promise<Credential | undefined> {
  if (!encryptionKey) return undefined;
  const [user] = await db
    .select({ providerId: users.defaultProviderId, model: users.defaultModel })
    .from(users)
    .where(eq(users.id, userId));
  const providerId = user?.providerId;
  const model = user?.model;
  if (!providerId || !model || !allowedProviders.includes(providerId)) return undefined;
  const provider = await findProvider(db, providerId);
  if (!provider?.enabled || provider.kind !== "cloud") return undefined;
  const apiKey = await getDecrypted(db, userId, providerId, encryptionKey);
  return apiKey ? { providerId, model, apiKey } : undefined;
}
