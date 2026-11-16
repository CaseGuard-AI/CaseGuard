import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { providers, users, type Provider, type User } from "../db/schema.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";

// Cursor: see src/lib/cursor.ts. The user list compares (created_at, id).

/** Every user, oldest first. Returns one page and the cursor for the next, or null at the end. */
export async function listUsers(
  db: Db,
  page: { cursor?: string; limit: number },
): Promise<{ items: User[]; nextCursor: string | null }> {
  const after = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(users)
    .where(
      after
        ? sql`(${users.createdAt}, ${users.id}) > (select created_at, id from app.users where id = ${after})`
        : undefined,
    )
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null };
}

/** Sets AI access for a user (FR-AUTH-3). Returns undefined if there's no such user. */
export async function setUserAiEnabled(
  db: Db,
  userId: string,
  aiEnabled: boolean,
): Promise<User | undefined> {
  const [user] = await db
    .update(users)
    .set({ aiEnabled, updatedAt: sql`now()` })
    .where(eq(users.id, userId))
    .returning();
  return user;
}

export function listProviders(db: Db): Promise<Provider[]> {
  return db.select().from(providers).orderBy(asc(providers.name));
}

/** Switches a provider on or off (SEC-11). Returns undefined if there's no such provider. */
export async function setProviderEnabled(
  db: Db,
  id: string,
  enabled: boolean,
): Promise<Provider | undefined> {
  const [provider] = await db
    .update(providers)
    .set({ enabled, updatedAt: sql`now()` })
    .where(eq(providers.id, id))
    .returning();
  return provider;
}

/** Ids of the enabled providers, sorted: the allow-list sent with every question (SEC-11, #75). */
export async function enabledProviderIds(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: providers.id })
    .from(providers)
    .where(eq(providers.enabled, true))
    .orderBy(asc(providers.id));
  return rows.map((r) => r.id);
}
