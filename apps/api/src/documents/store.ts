import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { DocumentFlag, IngestionStage } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import { documentStages, documents, type Document, type DocumentStatus } from "../db/schema.js";
import { decodeCursor, encodeCursor, isUuid } from "../lib/cursor.js";

interface Owner {
  userId: string;
  accountId: string;
}

export type NewDocument = Pick<
  Document,
  "id" | "caseId" | "filename" | "mediaType" | "sizeBytes" | "storageKey"
>;

const visible = isNull(documents.deletedAt);

export async function insertDocument(db: Db, owner: Owner, doc: NewDocument): Promise<Document> {
  const [row] = await db
    .insert(documents)
    .values({ ...doc, ownerUserId: owner.userId, accountId: owner.accountId })
    .returning();
  return row!;
}

/** The document if this user owns it and it isn't deleted, else undefined (404, FR-AUTH-4). */
export async function findOwnDocument(
  db: Db,
  owner: Owner,
  id: string,
): Promise<Document | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.ownerUserId, owner.userId), visible));
  return row;
}

/** Any user's document, for the jobs. Undefined once it is deleted. */
export async function findDocumentForJob(db: Db, id: string): Promise<Document | undefined> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), visible));
  return row;
}

/** The user's documents, newest first, optionally of one case (FR-DOC-3, FR-CASE-4). */
export async function listDocuments(
  db: Db,
  owner: Owner,
  page: { caseId?: string; cursor?: string; limit: number },
): Promise<{ items: Document[]; nextCursor: string | null }> {
  const before = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.ownerUserId, owner.userId),
        visible,
        page.caseId ? eq(documents.caseId, page.caseId) : undefined,
        before
          ? sql`(${documents.createdAt}, ${documents.id}) < (select created_at, id from app.documents where id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null };
}

export interface StatusChange {
  status: DocumentStatus;
  /** Applies only while the document is on this attempt: a newer attempt or a delete wins. */
  ifAttempt: number;
  attempt?: number;
  error?: string | null;
  flags?: DocumentFlag[];
  pages?: number | null;
  processedAt?: Date | null;
}

export interface StatusTransition {
  document: Document;
  previous: DocumentStatus;
}

/**
 * Every status change of a document goes through here (the document job and retry), so there is
 * one place that sees each transition. `updatedAt` moves only when the status changes (api.v1
 * Document.updatedAt). Undefined if the document is gone or on another attempt.
 */
export async function setDocumentStatus(
  db: Db,
  documentId: string,
  change: StatusChange,
): Promise<StatusTransition | undefined> {
  const { status, ifAttempt, ...fields } = change;
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ status: documents.status })
      .from(documents)
      .where(and(eq(documents.id, documentId), visible, eq(documents.attempt, ifAttempt)))
      .for("update");
    if (!current) return undefined;
    const [document] = await tx
      .update(documents)
      .set({
        ...set,
        status,
        ...(current.status !== status ? { updatedAt: sql`now()` } : {}),
      })
      .where(eq(documents.id, documentId))
      .returning();
    // Notifications (#103) hook in here, inside this transaction, on entering a final status.
    return { document: document!, previous: current.status };
  });
}

/** Copies one attempt's stage outcomes into the stage log (FR-DOC-2). */
export async function recordStages(
  db: Db,
  doc: Pick<Document, "id" | "ownerUserId" | "accountId">,
  attempt: number,
  stages: IngestionStage[],
): Promise<void> {
  if (stages.length === 0) return;
  const rows = stages.map((s) => ({
    documentId: doc.id,
    ownerUserId: doc.ownerUserId,
    accountId: doc.accountId,
    attempt,
    stage: s.stage,
    state: s.state,
    startedAt: s.startedAt ? new Date(s.startedAt) : null,
    finishedAt: s.finishedAt ? new Date(s.finishedAt) : null,
    flags: s.flags,
  }));
  await db
    .insert(documentStages)
    .values(rows)
    .onConflictDoUpdate({
      target: [documentStages.documentId, documentStages.attempt, documentStages.stage],
      set: {
        state: sql`excluded.state`,
        startedAt: sql`excluded.started_at`,
        finishedAt: sql`excluded.finished_at`,
        flags: sql`excluded.flags`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Hides the document from the API at once (deleteDocument); the purge job removes the file, the
 * chunks and then the row. Undefined if the user doesn't own it.
 */
export async function markDeleted(db: Db, owner: Owner, id: string): Promise<Document | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .update(documents)
    .set({ deletedAt: sql`now()` })
    .where(and(eq(documents.id, id), eq(documents.ownerUserId, owner.userId), visible))
    .returning();
  return row;
}

/** The last step of the purge: the row and its stage log. */
export async function removeDocumentRow(db: Db, id: string): Promise<void> {
  await db.delete(documents).where(eq(documents.id, id));
}
