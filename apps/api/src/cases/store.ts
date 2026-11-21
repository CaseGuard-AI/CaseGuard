import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cases, type Case, type NewCase } from "../db/schema.js";
import { decodeCursor, encodeCursor, isUuid } from "../lib/cursor.js";
import { HttpProblem } from "../lib/problem.js";

interface Owner {
  userId: string;
  accountId: string;
}

export type CaseState = "active" | "archived" | "all";

/** The editable fields (api.v1 CaseInput / CaseUpdate). */
export type CaseFields = Omit<
  NewCase,
  "id" | "ownerUserId" | "accountId" | "archivedAt" | "createdAt" | "updatedAt"
>;

const stateFilter = {
  active: isNull(cases.archivedAt),
  archived: isNotNull(cases.archivedAt),
  all: undefined,
} as const;

/** The user's cases, most recently updated first (FR-CASE-1). */
export async function listCases(
  db: Db,
  owner: Owner,
  page: { state: CaseState; cursor?: string; limit: number },
): Promise<{ items: Case[]; nextCursor: string | null }> {
  const before = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(cases)
    .where(
      and(
        eq(cases.ownerUserId, owner.userId),
        stateFilter[page.state],
        before
          ? sql`(${cases.updatedAt}, ${cases.id}) < (select updated_at, id from app.cases where id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(cases.updatedAt), desc(cases.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null };
}

export async function createCase(db: Db, owner: Owner, fields: CaseFields): Promise<Case> {
  const [row] = await db
    .insert(cases)
    .values({ ...fields, ownerUserId: owner.userId, accountId: owner.accountId })
    .returning();
  return row!;
}

/** The case if this user owns it, else undefined (callers answer 404, FR-AUTH-4). */
export async function findOwnCase(db: Db, owner: Owner, id: string): Promise<Case | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, id), eq(cases.ownerUserId, owner.userId)));
  return row;
}

/** Applies a partial update. Undefined if the user doesn't own the case. */
export async function updateCase(
  db: Db,
  owner: Owner,
  id: string,
  patch: Partial<CaseFields>,
): Promise<Case | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .update(cases)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(cases.id, id), eq(cases.ownerUserId, owner.userId)))
    .returning();
  return row;
}

/**
 * Archives or restores a case. Idempotent: archiving twice keeps the first archivedAt, and
 * neither touches updatedAt (it isn't an edit). Undefined if the user doesn't own the case.
 */
export async function setArchived(
  db: Db,
  owner: Owner,
  id: string,
  archived: boolean,
): Promise<Case | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .update(cases)
    .set({ archivedAt: archived ? sql`coalesce(${cases.archivedAt}, now())` : null })
    .where(and(eq(cases.id, id), eq(cases.ownerUserId, owner.userId)))
    .returning();
  return row;
}

/**
 * The rule for saving a conversation to a case (FR-CASE-5): it must be the caller's own active
 * case, else 400 on `caseId`. Another user's case gets the same answer as an unknown id, so
 * nothing is revealed about it (FR-AUTH-4).
 */
export async function requireActiveCase(
  db: Db,
  owner: Owner,
  caseId: string,
  what = "conversation",
): Promise<Case> {
  const found = await findOwnCase(db, owner, caseId);
  if (!found || found.archivedAt) {
    const message = found ? "That case is archived" : "No such case";
    throw new HttpProblem(400, "Bad Request", `The ${what} can't be saved to that case.`, {
      errors: [{ path: "caseId", message }],
    });
  }
  return found;
}
