// app.drafts and app.draft_citations (#213, FR-DRAFT-2, FR-DRAFT-4, FR-CASE-5, FR-AUTH-4).
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Citation } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import {
  aiAuditRecords,
  draftCitations,
  drafts,
  type Draft,
  type DraftSection,
  type DraftTemplateId,
} from "../db/schema.js";
import { decodeCursor, encodeCursor, isUuid } from "../lib/cursor.js";

interface Owner {
  userId: string;
  accountId: string;
}

/** The user's drafts, most recently updated first, optionally only one case's (FR-CASE-4). */
export async function listDrafts(
  db: Db,
  owner: Owner,
  page: { cursor?: string; limit: number; caseId?: string },
): Promise<{ items: Draft[]; nextCursor: string | null }> {
  const before = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(drafts)
    .where(
      and(
        eq(drafts.ownerUserId, owner.userId),
        page.caseId ? eq(drafts.caseId, page.caseId) : undefined,
        before
          ? sql`(${drafts.updatedAt}, ${drafts.id}) < (select updated_at, id from app.drafts where id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null };
}

export async function insertDraft(
  db: Db,
  owner: Owner,
  values: {
    templateId: DraftTemplateId;
    templateVersion: string;
    caseId: string | null;
    title: string;
    fields: Record<string, string | null>;
    sections: DraftSection[];
  },
): Promise<Draft> {
  const [row] = await db
    .insert(drafts)
    .values({ ...values, ownerUserId: owner.userId, accountId: owner.accountId })
    .returning();
  return row!;
}

/** The draft if this user owns it, else undefined (callers answer 404, FR-AUTH-4). */
export async function findOwnDraft(db: Db, owner: Owner, id: string): Promise<Draft | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.ownerUserId, owner.userId)));
  return row;
}

/**
 * Saves a draft if `version` is still its current version, and increments it (optimistic
 * concurrency). "stale" when someone saved in between; undefined if the user doesn't own it.
 */
export async function saveDraft(
  db: Db,
  owner: Owner,
  id: string,
  values: {
    version: number;
    title: string;
    caseId: string | null;
    fields: Record<string, string | null>;
    sections: DraftSection[];
  },
): Promise<Draft | "stale" | undefined> {
  if (!isUuid(id)) return undefined;
  const { version, ...rest } = values;
  const [row] = await db
    .update(drafts)
    .set({ ...rest, version: sql`${drafts.version} + 1`, updatedAt: sql`now()` })
    .where(
      and(eq(drafts.id, id), eq(drafts.ownerUserId, owner.userId), eq(drafts.version, version)),
    )
    .returning();
  if (row) return row;
  return (await findOwnDraft(db, owner, id)) ? "stale" : undefined;
}

export async function deleteOwnDraft(db: Db, owner: Owner, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .delete(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.ownerUserId, owner.userId)))
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/** Which of `ids` assist issued for this draft. */
export async function issuedCitationIds(
  db: Db,
  draftId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: draftCitations.citationId })
    .from(draftCitations)
    .where(and(eq(draftCitations.draftId, draftId), inArray(draftCitations.citationId, ids)));
  return new Set(rows.map((r) => r.id));
}

/** Whether the citation was issued to one of this user's drafts (GET /citations/{id}). */
export async function userHasDraftCitation(
  db: Db,
  userId: string,
  citationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: draftCitations.citationId })
    .from(draftCitations)
    .innerJoin(drafts, eq(drafts.id, draftCitations.draftId))
    .where(and(eq(draftCitations.citationId, citationId), eq(drafts.ownerUserId, userId)))
    .limit(1);
  return row !== undefined;
}

export interface AssistContext {
  requestId: string;
  owner: Owner;
  draft: Draft;
  sectionKey: string;
  instruction?: string;
  allowedProviders: string[];
  /** The user's own provider and model, when their key was sent (FR-SET-2). Never the key. */
  providerId?: string;
  model?: string;
  latencyMs: number;
}

/** The query as audited (§13.3): what was drafted, and the user's instruction if any. */
function auditQuery(ctx: AssistContext): string {
  const what = `Draft section ${ctx.draft.templateId}/${ctx.sectionKey}`;
  return ctx.instruction ? `${what}: ${ctx.instruction}` : what;
}

function auditBase(ctx: AssistContext) {
  return {
    requestId: ctx.requestId,
    ownerUserId: ctx.owner.userId,
    accountId: ctx.owner.accountId,
    conversationId: null,
    caseId: ctx.draft.caseId,
    draftId: ctx.draft.id,
    question: auditQuery(ctx),
    allowedProviders: ctx.allowedProviders,
    providerId: ctx.providerId ?? null,
    model: ctx.model ?? null,
    latencyMs: ctx.latencyMs,
  };
}

/**
 * Records the citations assist issued for the draft and the audit record, in one transaction
 * (FR-DRAFT-3, FR-TRUST-12). Nothing is written into the draft itself.
 */
export async function recordAssist(
  db: Db,
  ctx: AssistContext,
  result: { text: string; citations: Citation[] },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (result.citations.length > 0) {
      await tx
        .insert(draftCitations)
        .values(result.citations.map((c) => ({ draftId: ctx.draft.id, citationId: c.id })))
        .onConflictDoNothing();
    }
    await tx.insert(aiAuditRecords).values({
      ...auditBase(ctx),
      outcome: "answered",
      responseText: result.text,
      citations: result.citations,
    });
  });
}

/** Audits a failed assist. */
export async function auditAssistFailure(db: Db, ctx: AssistContext, error: string): Promise<void> {
  await db.insert(aiAuditRecords).values({ ...auditBase(ctx), outcome: "error", error });
}
