import { and, desc, eq, sql } from "drizzle-orm";
import type { LintDocumentType, LintResult } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import { lintReports, type LintReport } from "../db/schema.js";
import { decodeCursor, encodeCursor, isUuid } from "../lib/cursor.js";

interface Owner {
  userId: string;
  accountId: string;
}

export interface NewLintReport {
  documentType: LintDocumentType;
  title: string;
  /** Exactly as linted (FR-LINT-3). */
  text: string;
  caseId: string | null;
  draftId: string | null;
  result: LintResult;
}

export async function insertLintReport(
  db: Db,
  owner: Owner,
  fields: NewLintReport,
): Promise<LintReport> {
  const { result, ...rest } = fields;
  const [row] = await db
    .insert(lintReports)
    .values({
      ...rest,
      ownerUserId: owner.userId,
      accountId: owner.accountId,
      inputSha256: result.inputSha256,
      rulesetId: result.rulesetId,
      rulesetVersion: result.rulesetVersion,
      findings: result.findings,
    })
    .returning();
  return row!;
}

/** The owner's reports, newest first, optionally of one case (FR-CASE-4). */
export async function listLintReports(
  db: Db,
  owner: Owner,
  page: { caseId?: string; cursor?: string; limit: number },
): Promise<{ items: LintReport[]; nextCursor: string | null }> {
  const before = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(lintReports)
    .where(
      and(
        eq(lintReports.ownerUserId, owner.userId),
        page.caseId ? eq(lintReports.caseId, page.caseId) : undefined,
        before
          ? sql`(${lintReports.createdAt}, ${lintReports.id}) < (select created_at, id from app.lint_reports where id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(lintReports.createdAt), desc(lintReports.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > page.limit && last ? encodeCursor(last.id) : null,
  };
}

/** The owner's report, or undefined for an unknown id or another user's (FR-AUTH-4). */
export async function findOwnLintReport(
  db: Db,
  owner: Owner,
  id: string,
): Promise<LintReport | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select()
    .from(lintReports)
    .where(and(eq(lintReports.id, id), eq(lintReports.ownerUserId, owner.userId)));
  return row;
}

/** Deletes the owner's report. False if there was none to delete. */
export async function deleteLintReport(db: Db, owner: Owner, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db
    .delete(lintReports)
    .where(and(eq(lintReports.id, id), eq(lintReports.ownerUserId, owner.userId)))
    .returning({ id: lintReports.id });
  return rows.length > 0;
}
