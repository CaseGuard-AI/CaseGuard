import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, type User } from "../db/schema.js";

export type SettingsPatch = Partial<Pick<User, "name" | "locale" | "theme">>;

/** Changes some of a user's own settings (FR-SET-1). Returns undefined if there's no such user. */
export async function updateSettings(
  db: Db,
  userId: string,
  patch: SettingsPatch,
): Promise<User | undefined> {
  const [user] = await db
    .update(users)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(users.id, userId))
    .returning();
  return user;
}
