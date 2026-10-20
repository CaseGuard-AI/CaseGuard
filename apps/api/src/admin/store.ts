import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { providers, users, type Provider, type User } from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";

// Cursor for the user list: opaque to clients, base64url of the last user's id. The next page
// compares (created_at, id) in SQL, so microsecond timestamps never round through JavaScript.
const encodeCursor = (id: string) => Buffer.from(id).toString("base64url");

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new HttpProblem(400, "Bad Request", "The cursor is invalid.");
  }
  return id;
}

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
