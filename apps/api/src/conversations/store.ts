import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Answer, Language, Turn } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import {
  aiAuditRecords,
  conversations,
  messages,
  type Conversation,
  type Message,
} from "../db/schema.js";
import { HttpProblem } from "../lib/problem.js";

export const DEFAULT_TITLE = "New conversation";
const MAX_HISTORY = 20; // ai.v1 AnswerRequest.history maxItems

interface Owner {
  userId: string;
  accountId: string;
}

// Cursor: base64url of the last conversation's id; the next page compares (updated_at, id) in
// SQL, as in src/admin/store.ts.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID.test(id)) throw new HttpProblem(400, "Bad Request", "The cursor is invalid.");
  return id;
}

/** The user's conversations, most recently active first (FR-RES-8). */
export async function listConversations(
  db: Db,
  owner: Owner,
  page: { cursor?: string; limit: number },
): Promise<{ items: Conversation[]; nextCursor: string | null }> {
  const before = page.cursor ? decodeCursor(page.cursor) : undefined;
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.ownerUserId, owner.userId),
        before
          ? sql`(${conversations.updatedAt}, ${conversations.id}) < (select updated_at, id from app.conversations where id = ${before})`
          : undefined,
      ),
    )
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(page.limit + 1);
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > page.limit && last ? Buffer.from(last.id).toString("base64url") : null,
  };
}

export async function createConversation(
  db: Db,
  owner: Owner,
  title: string | undefined,
): Promise<Conversation> {
  const [row] = await db
    .insert(conversations)
    .values({
      ownerUserId: owner.userId,
      accountId: owner.accountId,
      title: title ?? DEFAULT_TITLE,
    })
    .returning();
  return row!;
}

/** The conversation if this user owns it, else undefined (callers answer 404, FR-AUTH-4). */
export async function findOwnConversation(
  db: Db,
  owner: Owner,
  id: string,
): Promise<Conversation | undefined> {
  if (!UUID.test(id)) return undefined;
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.ownerUserId, owner.userId)));
  return row;
}

export function listMessages(db: Db, conversationId: string): Promise<Message[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq));
}

/** The most recent turns, oldest first, for the AI's conversational context. */
export async function recentTurns(db: Db, conversationId: string): Promise<Turn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.text })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .limit(MAX_HISTORY);
  return rows.reverse();
}

export interface AskContext {
  requestId: string;
  owner: Owner;
  conversation: Conversation;
  question: string;
  language?: Language;
  lawAsOf?: string;
  allowedProviders: string[];
  latencyMs: number;
}

/**
 * Stores a question, its answer and the audit record in one transaction, so a conversation
 * never holds a question without its answer. Returns the assistant message.
 */
export async function saveExchange(db: Db, ctx: AskContext, answer: Answer): Promise<Message> {
  return db.transaction(async (tx) => {
    const base = {
      conversationId: ctx.conversation.id,
      ownerUserId: ctx.owner.userId,
      accountId: ctx.owner.accountId,
    };
    await tx
      .insert(messages)
      .values({ ...base, role: "user", text: ctx.question, language: ctx.language ?? null });
    const [assistant] = await tx
      .insert(messages)
      .values({
        ...base,
        role: "assistant",
        text: answer.text,
        language: answer.language,
        answerable: answer.answerable,
        citations: answer.citations,
        asOfNote: answer.asOfNote ?? null,
      })
      .returning();
    await tx
      .update(conversations)
      .set({
        updatedAt: sql`now()`,
        // The first question names an untitled conversation.
        ...(ctx.conversation.title === DEFAULT_TITLE ? { title: truncate(ctx.question, 80) } : {}),
      })
      .where(eq(conversations.id, ctx.conversation.id));
    await tx.insert(aiAuditRecords).values({
      ...auditBase(ctx),
      outcome: answer.answerable ? "answered" : "unanswerable",
      responseText: answer.text,
      answerLanguage: answer.language,
      citations: answer.citations,
    });
    return assistant!;
  });
}

/** Audits a failed ask. Nothing is added to the conversation. */
export async function auditFailure(db: Db, ctx: AskContext, error: string): Promise<void> {
  await db.insert(aiAuditRecords).values({ ...auditBase(ctx), outcome: "error", error });
}

function auditBase(ctx: AskContext) {
  return {
    requestId: ctx.requestId,
    ownerUserId: ctx.owner.userId,
    accountId: ctx.owner.accountId,
    conversationId: ctx.conversation.id,
    caseId: ctx.conversation.caseId,
    question: ctx.question,
    language: ctx.language ?? null,
    lawAsOf: ctx.lawAsOf ?? null,
    allowedProviders: ctx.allowedProviders,
    latencyMs: ctx.latencyMs,
  };
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Whether the citation appears in one of this user's own answers. The citations route checks
 * this before asking services/ai, so another user's citation is a 404 with no content
 * (FR-AUTH-4). Served by the GIN index on messages.citations (migration 0005).
 */
export async function userHasCitation(
  db: Db,
  userId: string,
  citationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.ownerUserId, userId),
        eq(messages.role, "assistant"),
        sql`${messages.citations} @> ${JSON.stringify([{ id: citationId }])}::jsonb`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
