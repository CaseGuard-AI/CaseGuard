import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notifications, type Notification, type NotificationKind } from "../db/schema.js";
import { decodeCursor, encodeCursor, isUuid } from "../lib/cursor.js";

interface Owner {
  userId: string;
  accountId: string;
}

export interface NewNotification {
  kind: NotificationKind;
  documentId: string;
  caseId: string;
  filename: string;
}

/**
 * Records a notification for the owner (FR-NOT-1). Takes the caller's transaction, so a
 * document's status change and its notification commit together.
 */
export async function createNotification(
  db: Pick<Db, "insert">,
  owner: Owner,
  fields: NewNotification,
): Promise<Notification> {
  const [row] = await db
    .insert(notifications)
    .values({ ...fields, ownerUserId: owner.userId, accountId: owner.accountId })
    .returning();
  return row!;
}

/** The user's notifications, newest first, with their unread total (FR-NOT-1). */
export async function listNotifications(
  db: Db,
  owner: Owner,
  page: { unread: boolean; cursor?: string; limit: number },
): Promise<{ items: Notification[]; nextCursor: string | null; unreadCount: number }> {
  const before = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.ownerUserId, owner.userId),
        page.unread ? isNull(notifications.readAt) : undefined,
        before
          ? sql`(${notifications.createdAt}, ${notifications.id}) < (select created_at, id from app.notifications where id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null,
    unreadCount: await countUnread(db, owner),
  };
}

export async function countUnread(db: Db, owner: Owner): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.ownerUserId, owner.userId), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

/**
 * Marks one notification read. Idempotent: the first readAt is kept. False if the user
 * doesn't own it (callers answer 404, FR-AUTH-4).
 */
export async function markRead(db: Db, owner: Owner, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const [row] = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, id), eq(notifications.ownerUserId, owner.userId)))
    .returning({ id: notifications.id });
  return row !== undefined;
}

export async function markAllRead(db: Db, owner: Owner): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: sql`now()` })
    .where(and(eq(notifications.ownerUserId, owner.userId), isNull(notifications.readAt)));
}
