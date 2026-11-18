import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { findOwnCase } from "../cases/store.js";
import type { Db } from "../db/client.js";
import type { Document } from "../db/schema.js";
import {
  findOwnDocument,
  insertDocument,
  listDocuments,
  markDeleted,
  setDocumentStatus,
} from "../documents/store.js";
import { cleanFilename, readUpload, sniffMediaType } from "../documents/upload.js";
import { firstStep, type JobQueue } from "../jobs/queue.js";
import { HttpProblem } from "../lib/problem.js";
import { uploadLimiter } from "../middleware/rate-limit.js";
import { BlobNotFound, documentKey, type BlobStore } from "../storage/blob-store.js";

const listQuery = z.object({
  caseId: z.uuid().optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** The contract's Document. */
export const toDocumentDto = (d: Document) => ({
  id: d.id,
  caseId: d.caseId,
  filename: d.filename,
  mediaType: d.mediaType,
  sizeBytes: d.sizeBytes,
  status: d.status,
  flags: d.flags,
  error: d.status === "failed" ? d.error : null,
  pages: d.pages,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
  processedAt: d.processedAt?.toISOString() ?? null,
});

const notFound = () => new HttpProblem(404, "Not Found", "No such document.");

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Documents of the signed-in user's cases (FR-DOC-1, FR-DOC-3). Another user's document is a 404
// (FR-AUTH-4). Processing runs in the document job, never on the request path (SEC-6).
export function documentsRouter(deps: {
  db: Db;
  jwtSecret: string;
  storage: BlobStore;
  jobs: JobQueue;
  maxUploadBytes: number;
}) {
  const { db, storage, jobs } = deps;
  const router = Router();
  const auth = requireAuth(deps.jwtSecret);
  router.use("/documents", auth);

  router.post("/cases/:caseId/documents", auth, uploadLimiter(), async (req, res) => {
    const owner = req.auth!;
    const found = await findOwnCase(db, owner, req.params.caseId as string);
    if (!found) throw new HttpProblem(404, "Not Found", "No such case.");
    if (found.archivedAt) {
      throw new HttpProblem(400, "Bad Request", "Files can't be added to an archived case.", {
        errors: [{ path: "caseId", message: "That case is archived" }],
      });
    }
    const upload = await readUpload(req, res, deps.maxUploadBytes);
    const mediaType = await sniffMediaType(upload.data);
    if (!mediaType) {
      throw new HttpProblem(
        415,
        "Unsupported Media Type",
        "Upload a PDF, DOCX, PNG, JPEG or TIFF file.",
      );
    }

    const id = randomUUID();
    const storageKey = documentKey(owner.userId, found.id, id);
    await storage.put(storageKey, upload.data);
    let created: Document;
    try {
      created = await insertDocument(db, owner, {
        id,
        caseId: found.id,
        filename: cleanFilename(upload.filename),
        mediaType,
        sizeBytes: upload.data.length,
        storageKey,
      });
    } catch (err) {
      await storage.delete(storageKey).catch(() => {});
      throw err;
    }
    // The row exists before its job, so a lost enqueue leaves a `queued` document the user can
    // see, never a job without a document.
    await jobs.ingest(firstStep(created, created.attempt));
    res.status(201).json(toDocumentDto(created));
  });

  router.get("/documents", async (req, res) => {
    const { items, nextCursor } = await listDocuments(db, req.auth!, listQuery.parse(req.query));
    res.json({ items: items.map(toDocumentDto), nextCursor });
  });

  router.get("/documents/:documentId", async (req, res) => {
    const found = await findOwnDocument(db, req.auth!, req.params.documentId);
    if (!found) throw notFound();
    res.json(toDocumentDto(found));
  });

  router.delete("/documents/:documentId", async (req, res) => {
    const deleted = await markDeleted(db, req.auth!, req.params.documentId);
    if (!deleted) throw notFound();
    await jobs.purge({
      documentId: deleted.id,
      userId: deleted.ownerUserId,
      caseId: deleted.caseId,
      storageKey: deleted.storageKey,
    });
    res.status(202).end();
  });

  router.get("/documents/:documentId/file", async (req, res) => {
    const found = await findOwnDocument(db, req.auth!, req.params.documentId);
    if (!found) throw notFound();
    let stream;
    try {
      stream = await storage.get(found.storageKey);
    } catch (err) {
      if (err instanceof BlobNotFound) throw notFound();
      throw err;
    }
    res.status(200);
    res.setHeader("Content-Type", found.mediaType);
    res.setHeader("Content-Length", String(found.sizeBytes));
    res.setHeader("Content-Disposition", contentDisposition(found.filename));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      res.on("finish", resolve);
      res.on("close", resolve);
      stream.pipe(res);
    });
  });

  router.post("/documents/:documentId/retry", async (req, res) => {
    const found = await findOwnDocument(db, req.auth!, req.params.documentId);
    if (!found) throw notFound();
    const conflict = () =>
      new HttpProblem(409, "Conflict", "Only a failed or flagged document can be retried.");
    if (found.status !== "failed" && found.status !== "flagged") throw conflict();
    const next = found.attempt + 1;
    const moved = await setDocumentStatus(db, found.id, {
      status: "queued",
      ifAttempt: found.attempt,
      attempt: next,
      error: null,
    });
    if (!moved) throw conflict();
    await jobs.ingest(firstStep(moved.document, next));
    res.status(202).json(toDocumentDto(moved.document));
  });

  return router;
}
