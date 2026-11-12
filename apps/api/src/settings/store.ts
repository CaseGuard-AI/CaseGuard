import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users, type User } from "../db/schema.js";

export type SettingsPatch = Partial<
  Pick<User, "name" | "locale" | "theme" | "defaultProviderId" | "defaultModel">
>;

/**
 * Changes some of a user's own settings (FR-SET-1, FR-SET-2). Returns undefined if there's no
 * such user. A default model is set or cleared as a pair (defaultProviderId with defaultModel).
 */
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
