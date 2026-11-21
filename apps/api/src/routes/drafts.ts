import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { enabledProviderIds } from "../admin/store.js";
import { requireAiEnabled, requireAuth } from "../auth/middleware.js";
import {
  AiHttpError,
  type AiClient,
  type Citation,
  type Credential,
  type DraftSectionResult,
  type DraftTemplate,
} from "../clients/ai.js";
import {
  parseCitation,
  parseDraftSection,
  parseDraftTemplates,
  parseSource,
} from "../clients/ai-schemas.js";
import { findOwnCase, requireActiveCase } from "../cases/store.js";
import type { Db } from "../db/client.js";
import { DRAFT_TEMPLATE_IDS, type Draft } from "../db/schema.js";
import { renderDocx, renderPdf, type ExportNote } from "../drafts/export.js";
import { fillFields, orderSections } from "../drafts/fill.js";
import { markerIds, sectionMarkerIds } from "../drafts/markers.js";
import {
  auditAssistFailure,
  deleteOwnDraft,
  findOwnDraft,
  insertDraft,
  issuedCitationIds,
  listDrafts,
  recordAssist,
  saveDraft,
  type AssistContext,
} from "../drafts/store.js";
import { resolveCredential } from "../keys/credential.js";
import { HttpProblem } from "../lib/problem.js";
import { aiLimiter } from "../middleware/rate-limit.js";
import { contentDisposition } from "./documents.js";

// packages/contracts api.v1: DraftCaseId, Cursor, Limit, DraftCreate, DraftUpdate,
// DraftAssistRequest, the export format.
const sectionKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const fieldValues = z.record(z.string(), z.string().max(4000).nullable());

const pageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  caseId: z.uuid().optional(),
});

const createBody = z.strictObject({
  templateId: z.enum(DRAFT_TEMPLATE_IDS),
  title: z.string().trim().min(1).max(200).optional(),
  caseId: z.uuid().nullable().optional(),
});

const updateBody = z.strictObject({
  version: z.number().int().min(1),
  title: z.string().trim().min(1).max(200),
  caseId: z.uuid().nullable(),
  fields: fieldValues,
  sections: z.array(z.strictObject({ key: sectionKey, body: z.string().max(20000) })).max(30),
});

const assistBody = z.strictObject({ instruction: z.string().trim().max(2000).optional() });
const exportQuery = z.object({ format: z.enum(["docx", "pdf"]) });

const MEDIA_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
} as const;

const notFound = () => new HttpProblem(404, "Not Found", "No such draft.");
const unavailable = () =>
  new HttpProblem(
    503,
    "Service Unavailable",
    "The drafting service is unavailable. Try again shortly.",
  );
const badRequest = (detail: string, path: string, message: string) =>
  new HttpProblem(400, "Bad Request", detail, { errors: [{ path, message }] });

const toSummary = (d: Draft) => ({
  id: d.id,
  templateId: d.templateId,
  title: d.title,
  caseId: d.caseId,
  version: d.version,
  updatedAt: d.updatedAt.toISOString(),
});

/** A file name from the draft's title: letters, digits and dashes, never empty. */
export function exportFilename(title: string, format: "docx" | "pdf"): string {
  const base = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return `${base || "draft"}.${format}`;
}

// api.v1 tag "drafting" (FR-DRAFT-1..4, FR-CASE-5). Owner only: another user's draft is a 404.
export function draftsRouter(deps: {
  db: Db;
  jwtSecret: string;
  ai: AiClient;
  encryptionKey?: Buffer;
}) {
  const { db, ai, encryptionKey } = deps;
  const router = Router();
  router.use(["/drafting", "/drafts"], requireAuth(deps.jwtSecret));

  // The templates change only with a services/ai release, so the first good answer is kept.
  // A failure is not cached.
  let cached: Promise<DraftTemplate[]> | undefined;
  async function templates(req: Request): Promise<DraftTemplate[]> {
    cached ??= ai.listDraftTemplates().then((raw) => parseDraftTemplates(raw).items);
    try {
      return await cached;
    } catch (err) {
      cached = undefined;
      req.log.error({ err }, "AI service drafting templates lookup failed");
      throw unavailable();
    }
  }
  async function templateOf(req: Request, id: string): Promise<DraftTemplate> {
    const found = (await templates(req)).find((t) => t.id === id);
    if (!found) throw unavailable(); // services/ai no longer serves a template the contract has
    return found;
  }

  /** The citations marked in the sections, each with its current stored status (FR-TRUST-10). */
  async function citationsOf(req: Request, sections: { body: string }[]): Promise<Citation[]> {
    const ids = sectionMarkerIds(sections);
    const found = await Promise.all(
      ids.map(async (id) => {
        try {
          return parseCitation(await ai.getCitation(id));
        } catch (err) {
          if (err instanceof AiHttpError && err.status === 404) return undefined;
          req.log.error({ err }, "AI service citation lookup failed");
          throw unavailable();
        }
      }),
    );
    return found.filter((c): c is Citation => c !== undefined);
  }

  async function toDraftDto(req: Request, d: Draft) {
    const template = await templateOf(req, d.templateId);
    const fields = Object.fromEntries(template.fields.map((f) => [f.key, d.fields[f.key] ?? null]));
    const sections = orderSections(template, d.sections);
    return {
      id: d.id,
      templateId: d.templateId,
      templateVersion: d.templateVersion,
      title: d.title,
      caseId: d.caseId,
      fields,
      sections,
      citations: await citationsOf(req, sections),
      version: d.version,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  }

  router.get("/drafting/templates", async (req, res) => {
    res.json({ items: await templates(req) });
  });

  router.get("/drafts", async (req, res) => {
    const page = pageQuery.parse(req.query);
    const { items, nextCursor } = await listDrafts(db, req.auth!, page);
    res.json({ items: items.map(toSummary), nextCursor });
  });

  // Filled from the case when one is given (FR-DRAFT-2); works without one too.
  router.post("/drafts", async (req, res) => {
    const owner = req.auth!;
    const body = createBody.parse(req.body ?? {});
    const fromCase = body.caseId
      ? await requireActiveCase(db, owner, body.caseId, "draft")
      : undefined;
    const template = await templateOf(req, body.templateId);
    const title =
      body.title ?? (fromCase ? `${template.title}: ${fromCase.title}` : template.title);
    const draft = await insertDraft(db, owner, {
      templateId: template.id,
      templateVersion: template.version,
      caseId: fromCase?.id ?? null,
      title: title.slice(0, 200),
      fields: fillFields(template, fromCase),
      sections: orderSections(template, []),
    });
    res.status(201).json(await toDraftDto(req, draft));
  });

  router.get("/drafts/:draftId", async (req, res) => {
    const draft = await findOwnDraft(db, req.auth!, req.params.draftId);
    if (!draft) throw notFound();
    res.json(await toDraftDto(req, draft));
  });

  router.put("/drafts/:draftId", async (req, res) => {
    const owner = req.auth!;
    const draft = await findOwnDraft(db, owner, req.params.draftId);
    if (!draft) throw notFound();
    const body = updateBody.parse(req.body);
    const template = await templateOf(req, draft.templateId);

    const fieldKeys = new Set(template.fields.map((f) => f.key));
    const unknownField = Object.keys(body.fields).find((k) => !fieldKeys.has(k));
    if (unknownField) {
      throw badRequest(
        "That field is not in the template.",
        `fields.${unknownField}`,
        "Unknown field",
      );
    }
    const sectionKeys = new Set(template.sections.map((s) => s.key));
    const seen = new Set<string>();
    for (const [i, s] of body.sections.entries()) {
      if (!sectionKeys.has(s.key) || seen.has(s.key)) {
        throw badRequest(
          "That section is not in the template.",
          `sections.${i}.key`,
          seen.has(s.key) ? "Duplicate section" : "Unknown section",
        );
      }
      seen.add(s.key);
    }
    // Every marker must be a citation assist issued for this draft.
    const issued = await issuedCitationIds(db, draft.id, sectionMarkerIds(body.sections));
    for (const [i, s] of body.sections.entries()) {
      if (markerIds(s.body).some((id) => !issued.has(id))) {
        throw badRequest(
          "A citation marker was not issued for this draft.",
          `sections.${i}.body`,
          "Unknown citation",
        );
      }
    }
    if (body.caseId && body.caseId !== draft.caseId) {
      await requireActiveCase(db, owner, body.caseId, "draft");
    }

    const saved = await saveDraft(db, owner, draft.id, {
      version: body.version,
      title: body.title,
      caseId: body.caseId,
      fields: Object.fromEntries(template.fields.map((f) => [f.key, body.fields[f.key] ?? null])),
      sections: orderSections(template, body.sections),
    });
    if (saved === undefined) throw notFound();
    if (saved === "stale") {
      throw new HttpProblem(
        409,
        "Conflict",
        "This draft was saved somewhere else since you opened it. Reload it to continue.",
      );
    }
    res.json(await toDraftDto(req, saved));
  });

  router.delete("/drafts/:draftId", async (req, res) => {
    if (!(await deleteOwnDraft(db, req.auth!, req.params.draftId))) throw notFound();
    res.status(204).end();
  });

  // FR-DRAFT-3, FR-AUTH-3, FR-CASE-6, FR-TRUST-12, SEC-11: providers and the user's key as for
  // askQuestion.
  router.post(
    "/drafts/:draftId/sections/:sectionKey/assist",
    aiLimiter(),
    requireAiEnabled(db),
    async (req, res) => {
      const owner = req.auth!;
      const draft = await findOwnDraft(db, owner, String(req.params.draftId));
      if (!draft) throw notFound();
      const body = assistBody.parse(req.body ?? {});
      const key = String(req.params.sectionKey);
      const template = await templateOf(req, draft.templateId);
      const section = template.sections.find((s) => s.key === key);
      if (!section?.assistable) {
        throw badRequest(
          "That section can't be drafted with AI.",
          "sectionKey",
          section ? "Not assistable" : "Unknown section",
        );
      }

      const requestId = randomUUID();
      const started = Date.now();
      // Always sent explicitly: omitted means "local only" to services/ai (SEC-11, #75).
      const allowedProviders = await enabledProviderIds(db);
      // Holds the plaintext key: only ever in the AI request, never in ctx or a log line.
      let credential: Credential | undefined;
      try {
        credential = await resolveCredential(db, owner.userId, allowedProviders, encryptionKey);
      } catch {
        req.log.warn({ requestId }, "saved user key could not be decrypted; not using it");
      }
      const instruction = body.instruction || undefined;
      const ctx: Omit<AssistContext, "latencyMs"> = {
        requestId,
        owner,
        draft,
        sectionKey: key,
        ...(instruction ? { instruction } : {}),
        allowedProviders,
        ...(credential ? { providerId: credential.providerId, model: credential.model } : {}),
      };

      if (allowedProviders.length === 0) {
        await auditAssistFailure(
          db,
          { ...ctx, latencyMs: Date.now() - started },
          "no provider enabled",
        );
        throw new HttpProblem(
          503,
          "Service Unavailable",
          "No model provider is enabled. Ask an administrator to enable one.",
        );
      }
      // Only the draft's own case, and only while it is the caller's and active (FR-CASE-6).
      const ownCase = draft.caseId ? await findOwnCase(db, owner, draft.caseId) : undefined;
      const allowedCaseIds = ownCase && !ownCase.archivedAt ? [ownCase.id] : [];

      let result: DraftSectionResult;
      try {
        result = parseDraftSection(
          await ai.draftSection({
            requestId,
            templateId: draft.templateId,
            sectionKey: key,
            ...(instruction ? { instruction } : {}),
            fields: draft.fields,
            otherSections: draft.sections.filter((s) => s.key !== key && s.body.trim()),
            scope: { userId: owner.userId, accountId: owner.accountId, allowedCaseIds },
            allowedProviders,
            ...(credential ? { credential } : {}),
          }),
        );
        if (result.requestId !== requestId) throw new Error("result is for a different request");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        req.log.error({ err, requestId }, "drafting assist failed");
        await auditAssistFailure(db, { ...ctx, latencyMs: Date.now() - started }, reason);
        if (err instanceof AiHttpError && err.status === 400) {
          throw badRequest("That section can't be drafted.", "sectionKey", "Rejected");
        }
        throw unavailable();
      }

      await recordAssist(db, { ...ctx, latencyMs: Date.now() - started }, result);
      res.json({ sectionKey: key, text: result.text, citations: result.citations });
    },
  );

  // FR-DRAFT-4: the saved draft with its template's headings and a note per citation.
  router.get("/drafts/:draftId/export", async (req, res) => {
    const draft = await findOwnDraft(db, req.auth!, req.params.draftId);
    if (!draft) throw notFound();
    const { format } = exportQuery.parse(req.query);
    const template = await templateOf(req, draft.templateId);
    const sections = orderSections(template, draft.sections);
    const citations = await citationsOf(req, sections);
    const notes = new Map<string, ExportNote>();
    await Promise.all(
      citations.map(async (citation) => {
        let sourceTitle = "Case document";
        try {
          sourceTitle = parseSource(await ai.getSource(citation.sourceId)).title;
        } catch (err) {
          // A case document is not a corpus source (404); anything else is an outage.
          if (!(err instanceof AiHttpError && err.status === 404)) {
            req.log.error({ err }, "AI service source lookup failed");
            throw unavailable();
          }
        }
        notes.set(citation.id, { citation, sourceTitle });
      }),
    );
    const model = {
      title: draft.title,
      sections: template.sections.map((s, i) => ({ heading: s.heading, body: sections[i]!.body })),
      notes,
    };
    const file = format === "docx" ? await renderDocx(model) : await renderPdf(model);
    res.setHeader("Content-Type", MEDIA_TYPES[format]);
    res.setHeader("Content-Length", String(file.length));
    res.setHeader("Content-Disposition", contentDisposition(exportFilename(draft.title, format)));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.end(file);
  });

  return router;
}
