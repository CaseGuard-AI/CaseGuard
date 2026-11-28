// One step of the document.ingest job (ADR-0010): apps/api submits each attempt to services/ai
// and polls it; services/ai never calls back. A document is never dropped (NFR-13): every path
// ends in done, flagged or failed, and a failed document stays listed for the user to retry.
import { parseIngestionStatus } from "../clients/ai-schemas.js";
import { AiHttpError, type AiClient, type IngestionStatus } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import type { Document } from "../db/schema.js";
import { findDocumentForJob, recordStages, setDocumentStatus } from "../documents/store.js";
import type { Logger } from "../lib/logger.js";
import type { IngestJob, JobQueue } from "./queue.js";

export const POLL_MAX_MS = 30_000;
/** How long an attempt may run once services/ai has started it. */
export const ATTEMPT_TIMEOUT_MS = 30 * 60_000;
/** How long an attempt may wait in services/ai's queue (one attempt runs at a time there). */
export const QUEUED_TIMEOUT_MS = 6 * 60 * 60_000;
/** Seconds before automatic retry n (1, 2, …) is submitted. */
export const retryDelaySeconds = (n: number) => 30 * n;

// For the user (Document.error): what happened, never how the pipeline failed.
export const MESSAGES = {
  unavailable: "The document could not be processed because the processing service is unavailable.",
  rejected: "The document could not be processed.",
  timeout: "Processing took too long.",
} as const;

export interface IngestDeps {
  db: Db;
  ai: AiClient;
  queue: JobQueue;
  logger: Logger;
  /** Attempts per run, automatic retries included (DOCUMENT_MAX_ATTEMPTS). */
  maxAttempts: number;
  now?: () => Date;
}

export async function runIngestStep(deps: IngestDeps, job: IngestJob): Promise<void> {
  const doc = await findDocumentForJob(deps.db, job.documentId);
  // Deleted, or the user retried and a newer attempt has its own job.
  if (!doc || doc.attempt !== job.attempt) return;
  const log = deps.logger.child({ documentId: doc.id, attempt: job.attempt });

  if (!job.submitted) {
    let status: IngestionStatus;
    try {
      status = parseIngestionStatus(
        await deps.ai.startIngestion(doc.id, {
          scope: {
            userId: doc.ownerUserId,
            accountId: doc.accountId,
            allowedCaseIds: [doc.caseId],
          },
          caseId: doc.caseId,
          storageKey: doc.storageKey,
          mediaType: doc.mediaType,
          filename: doc.filename,
          attempt: job.attempt,
        }),
      );
    } catch (err) {
      if (err instanceof AiHttpError && err.status === 409) {
        log.warn("services/ai holds a newer attempt; this one is dropped");
        return;
      }
      if (err instanceof AiHttpError && err.status === 400) {
        log.error({ err }, "services/ai rejected the ingestion request");
        return fail(deps, doc, job, MESSAGES.rejected, false);
      }
      log.warn({ err }, "could not submit the ingestion");
      return fail(deps, doc, job, MESSAGES.unavailable, true);
    }
    // The attempt's own deadline starts when it runs (apply); until then only the queue limit.
    const queuedDeadline = after(deps, QUEUED_TIMEOUT_MS);
    return apply(deps, doc, { ...job, submitted: true, deadline: null, queuedDeadline }, status);
  }

  const limit = job.deadline ?? job.queuedDeadline;
  if (limit && now(deps) > new Date(limit)) {
    log.warn("ingestion timed out");
    return fail(deps, doc, job, MESSAGES.timeout, true);
  }
  let status: IngestionStatus;
  try {
    status = parseIngestionStatus(await deps.ai.getIngestion(doc.id));
  } catch (err) {
    if (err instanceof AiHttpError && err.status === 404) {
      // services/ai has no record of it (contract: submit again).
      return deps.queue.ingest({ ...job, submitted: false });
    }
    // Down for a moment: poll again later; the deadline bounds this.
    log.warn({ err }, "could not poll the ingestion");
    return pollAgain(deps, job);
  }
  return apply(deps, doc, job, status);
}

async function apply(deps: IngestDeps, doc: Document, job: IngestJob, status: IngestionStatus) {
  if (status.attempt < job.attempt) return deps.queue.ingest({ ...job, submitted: false });
  if (status.attempt > job.attempt) return;
  await recordStages(deps.db, doc, job.attempt, status.stages);

  switch (status.state) {
    case "queued":
    case "running": {
      // While an automatic retry waits, the document shows `processing` (api.v1 DocumentStatus).
      const waiting = status.state === "queued" && job.attempt === job.firstAttempt;
      const moved = await setDocumentStatus(deps.db, doc.id, {
        status: waiting ? "queued" : "processing",
        ifAttempt: job.attempt,
        pages: status.pages,
      });
      const started = status.state === "running" && !job.deadline;
      if (moved) {
        await pollAgain(
          deps,
          started ? { ...job, deadline: after(deps, ATTEMPT_TIMEOUT_MS) } : job,
        );
      }
      return;
    }
    case "done":
    case "flagged":
      await setDocumentStatus(deps.db, doc.id, {
        status: status.state,
        ifAttempt: job.attempt,
        flags: status.state === "flagged" ? status.flags : [],
        error: null,
        pages: status.pages,
        processedAt: now(deps),
      });
      return;
    case "failed":
      return fail(deps, doc, job, status.error ?? MESSAGES.rejected, status.retryable);
  }
}

/** Retries automatically while attempts are left (NFR-13), else the document is `failed`. */
async function fail(
  deps: IngestDeps,
  doc: Document,
  job: IngestJob,
  message: string,
  retryable: boolean,
) {
  const used = job.attempt - job.firstAttempt + 1;
  if (retryable && used < deps.maxAttempts) {
    const next = job.attempt + 1;
    const moved = await setDocumentStatus(deps.db, doc.id, {
      status: "processing",
      ifAttempt: job.attempt,
      attempt: next,
    });
    if (moved) {
      await deps.queue.ingest(
        {
          ...job,
          attempt: next,
          submitted: false,
          pollMs: 2000,
          deadline: null,
          queuedDeadline: null,
        },
        retryDelaySeconds(used),
      );
    }
    return;
  }
  await setDocumentStatus(deps.db, doc.id, {
    status: "failed",
    ifAttempt: job.attempt,
    error: message.slice(0, 500),
    flags: [],
    processedAt: now(deps),
  });
}

function pollAgain(deps: IngestDeps, job: IngestJob) {
  return deps.queue.ingest(
    { ...job, pollMs: Math.min(job.pollMs * 2, POLL_MAX_MS) },
    job.pollMs / 1000,
  );
}

const now = (deps: IngestDeps) => deps.now?.() ?? new Date();
const after = (deps: IngestDeps, ms: number) => new Date(now(deps).getTime() + ms).toISOString();
