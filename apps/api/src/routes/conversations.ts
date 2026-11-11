import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { enabledProviderIds } from "../admin/store.js";
import { requireAiEnabled, requireAuth } from "../auth/middleware.js";
import type { AiClient, Answer, Credential } from "../clients/ai.js";
import { languageSchema, parseAnswer } from "../clients/ai-schemas.js";
import {
  auditFailure,
  createConversation,
  findOwnConversation,
  listConversations,
  listMessages,
  recentTurns,
  saveExchange,
  type AskContext,
} from "../conversations/store.js";
import type { Db } from "../db/client.js";
import type { Conversation, Message } from "../db/schema.js";
import { resolveCredential } from "../keys/credential.js";
import { HttpProblem } from "../lib/problem.js";
import { aiLimiter } from "../middleware/rate-limit.js";

// packages/contracts api.v1: Cursor, Limit, createConversation body, AskRequest.
const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  caseId: z.uuid().optional(),
});

const askBody = z.object({
  question: z.string().trim().min(1).max(4000),
  language: languageSchema.optional(),
  lawAsOf: z.iso.date().optional(),
});

// FR-RES-6: an answer reaches the user only if every citation carries a stored verification
// (checked by parseAnswer). FR-RES-9: an unanswerable answer carries no citations. Anything
// else is treated as a failure.
function checkAnswer(raw: unknown, requestId: string): Answer {
  const answer = parseAnswer(raw);
  if (answer.requestId !== requestId) throw new Error("answer is for a different request");
  if (!answer.answerable && answer.citations.length > 0) {
    throw new Error("an unanswerable answer carried citations");
  }
  return answer;
}

const toSummary = (c: Conversation) => ({
  id: c.id,
  title: c.title,
  caseId: c.caseId,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

/** The contract's Message. Fields that don't apply to the role are left out, not null. */
function toMessageDto(m: Message) {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    ...(m.language ? { language: m.language } : {}),
    ...(m.role === "assistant"
      ? { answerable: m.answerable ?? false, citations: m.citations ?? [] }
      : {}),
    createdAt: m.createdAt.toISOString(),
  };
}

const notFound = () => new HttpProblem(404, "Not Found", "No such conversation.");

export function conversationsRouter(deps: {
  db: Db;
  jwtSecret: string;
  ai: AiClient;
  encryptionKey?: Buffer;
}) {
  const { db, ai, encryptionKey } = deps;
  const router = Router();
  router.use("/conversations", requireAuth(deps.jwtSecret));

  router.get("/conversations", async (req, res) => {
    const page = pageQuery.parse(req.query);
    const { items, nextCursor } = await listConversations(db, req.auth!, page);
    res.json({ items: items.map(toSummary), nextCursor });
  });

  router.post("/conversations", async (req, res) => {
    const body = createBody.parse(req.body ?? {});
    if (body.caseId) {
      // Cases arrive in P1 (FR-CASE-6); until then no case is visible to scope to.
      throw new HttpProblem(400, "Bad Request", "Case-scoped conversations aren't available yet.", {
        errors: [{ path: "caseId", message: "Cases aren't available yet" }],
      });
    }
    const conversation = await createConversation(db, req.auth!, body.title);
    res.status(201).json({ ...toSummary(conversation), messages: [] });
  });

  router.get("/conversations/:conversationId", async (req, res) => {
    const conversation = await findOwnConversation(db, req.auth!, req.params.conversationId);
    if (!conversation) throw notFound();
    const messages = await listMessages(db, conversation.id);
    res.json({ ...toSummary(conversation), messages: messages.map(toMessageDto) });
  });

  // Ask a question (FR-RES-6, FR-AUTH-3, FR-CASE-6, FR-TRUST-12, SEC-15).
  router.post(
    "/conversations/:conversationId/messages",
    aiLimiter(),
    requireAiEnabled(db),
    async (req, res) => {
      const body = askBody.parse(req.body);
      const owner = req.auth!;
      const conversation = await findOwnConversation(db, owner, String(req.params.conversationId));
      if (!conversation) throw notFound();

      const requestId = randomUUID();
      const started = Date.now();
      // The Admin's allow-list, always sent explicitly: an omitted list means "local only"
      // to services/ai, never "whatever is enabled" (SEC-11, #75).
      const allowedProviders = await enabledProviderIds(db);
      // The user's own key for their default model, if it may be used (FR-SET-2, ADR-0009).
      // It holds the plaintext key, so it goes only into the AI request: never into ctx (which
      // is audited) or a log line.
      let credential: Credential | undefined;
      try {
        credential = await resolveCredential(db, owner.userId, allowedProviders, encryptionKey);
      } catch {
        // A key saved under a different KEY_ENCRYPTION_KEY: answer with the deployment's own
        // configuration rather than fail. The user can save the key again.
        req.log.warn({ requestId }, "saved user key could not be decrypted; not using it");
      }
      const ctx: Omit<AskContext, "latencyMs"> = {
        requestId,
        owner,
        conversation,
        question: body.question,
        ...(body.language ? { language: body.language } : {}),
        ...(body.lawAsOf ? { lawAsOf: body.lawAsOf } : {}),
        allowedProviders,
        ...(credential ? { providerId: credential.providerId, model: credential.model } : {}),
      };

      if (allowedProviders.length === 0) {
        await auditFailure(db, { ...ctx, latencyMs: Date.now() - started }, "no provider enabled");
        throw new HttpProblem(
          503,
          "Service Unavailable",
          "No model provider is enabled. Ask an administrator to enable one.",
        );
      }

      let answer: Answer;
      try {
        answer = checkAnswer(
          await ai.answer({
            requestId,
            question: body.question,
            ...(body.language ? { language: body.language } : {}),
            ...(body.lawAsOf ? { lawAsOf: body.lawAsOf } : {}),
            history: await recentTurns(db, conversation.id),
            // Public corpus only until cases land (P1). Never widened by the AI (FR-CASE-6).
            scope: { userId: owner.userId, accountId: owner.accountId, allowedCaseIds: [] },
            allowedProviders,
            ...(credential ? { credential } : {}),
          }),
          requestId,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        req.log.error({ err, requestId }, "research answer failed");
        await auditFailure(db, { ...ctx, latencyMs: Date.now() - started }, reason);
        throw new HttpProblem(
          503,
          "Service Unavailable",
          "The research service couldn't answer right now. Try again shortly.",
        );
      }

      const message = await saveExchange(db, { ...ctx, latencyMs: Date.now() - started }, answer);
      res.status(201).json(toMessageDto(message));
    },
  );

  return router;
}
