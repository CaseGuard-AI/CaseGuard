import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  AiHttpError,
  DOCUMENT_STAGES,
  type AiClient,
  type IngestionRequest,
  type IngestionStatus,
} from "../src/clients/ai.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrateUp } from "../src/db/migrate.js";
import {
  ATTEMPT_TIMEOUT_MS,
  MESSAGES,
  QUEUED_TIMEOUT_MS,
  runIngestStep,
  type IngestDeps,
} from "../src/jobs/ingest.js";
import { runPurge } from "../src/jobs/purge.js";
import type { IngestJob } from "../src/jobs/queue.js";
import { createLogger } from "../src/lib/logger.js";
import { PDF } from "./files.js";
import { memoryStore, noIngestion, recordingQueue } from "./stubs.js";

// Runs as caseguard_app against a bootstrapped database (CI sets APP_TEST_DATABASE_URL).
const url = process.env.APP_TEST_DATABASE_URL;

const unused = async (): Promise<never> => {
  throw new Error("not used");
};

const FLAG = { stage: "ocr" as const, code: "low_ocr_confidence", message: "Page 2", page: 2 };

/** An ingestion status as services/ai would report it. */
function status(
  documentId: string,
  attempt: number,
  state: IngestionStatus["state"],
  extra: Partial<IngestionStatus> = {},
): IngestionStatus {
  const finished = state === "done" || state === "flagged" || state === "failed";
  return {
    documentId,
    attempt,
    state,
    stages: DOCUMENT_STAGES.map((stage) => ({
      stage,
      state: finished ? (stage === "ocr" ? "skipped" : "done") : "pending",
      startedAt: finished ? "2026-11-19T10:00:00Z" : null,
      finishedAt: finished ? "2026-11-19T10:00:01Z" : null,
      flags: [],
    })),
    flags: [],
    error: null,
    retryable: false,
    pages: finished ? 3 : null,
    chunkCount: finished ? 12 : null,
    ...extra,
  };
}

describe.skipIf(!url)("document jobs (ADR-0010, NFR-13)", () => {
  let pool: pg.Pool;
  let db: Db;
  let app: ReturnType<typeof createApp>;
  let queue: ReturnType<typeof recordingQueue>;
  let storage: ReturnType<typeof memoryStore>;
  let token: string;
  let caseId: string;
  // Scripted services/ai: each test sets these.
  let onStart: (id: string, req: IngestionRequest) => Promise<IngestionStatus>;
  let onGet: (id: string) => Promise<IngestionStatus>;
  let onPurge: (id: string) => Promise<void>;
  const started: IngestionRequest[] = [];
  let clock: Date;

  const ai: AiClient = {
    ...noIngestion,
    info: async () => ({ service: "caseguard-ai", version: "test" }),
    answer: unused,
    getCitation: unused,
    getSource: unused,
    startIngestion: async (id, req) => {
      started.push(req);
      return onStart(id, req);
    },
    getIngestion: (id) => onGet(id),
    purgeDocument: (id) => onPurge(id),
  };

  const deps = (): IngestDeps => ({
    db,
    ai,
    queue,
    logger: createLogger("silent", false),
    maxAttempts: 3,
    now: () => clock,
  });

  const row = async (id: string) =>
    (
      await pool.query(
        "SELECT status, attempt, error, flags, pages, processed_at FROM app.documents WHERE id = $1",
        [id],
      )
    ).rows[0];

  /** Takes the job the last step enqueued. */
  const nextJob = () => {
    const next = queue.ingested.shift();
    if (!next) throw new Error("no job was enqueued");
    expect(queue.ingested).toEqual([]);
    return next;
  };

  async function uploaded(): Promise<{ id: string; job: IngestJob }> {
    const res = await request(app)
      .post(`/api/v1/cases/${caseId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("file", PDF, "FIR.pdf");
    expect(res.status).toBe(201);
    return { id: res.body.id, job: nextJob().job };
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrateUp(pool);
    db = createDb(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    queue = recordingQueue();
    storage = memoryStore();
    started.length = 0;
    clock = new Date("2026-11-19T10:00:00Z");
    onStart = async (id, req) => status(id, req.attempt, "queued");
    onGet = unused;
    onPurge = async () => {};
    app = createApp({
      env: {
        CORS_ORIGIN: "http://localhost:3000",
        JWT_SECRET: "j".repeat(32),
        RESET_URL_BASE: "http://localhost:3000/reset-password",
      },
      logger: createLogger("silent", false),
      db: pool,
      orm: db,
      ai,
      mailer: { send: async () => {} },
      storage,
      jobs: queue,
    });
    const reg = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "alice@example.com", password: "correct horse battery", name: "alice" });
    token = reg.body.accessToken;
    caseId = (
      await request(app)
        .post("/api/v1/cases")
        .set("Authorization", `Bearer ${token}`)
        .send({ title: "A case" })
    ).body.id;
  });

  afterAll(async () => {
    await pool.query("TRUNCATE app.accounts CASCADE");
    await pool.end();
  });

  it("submits the attempt with the owner's scope, then polls with backoff until done", async () => {
    const { id, job } = await uploaded();
    await runIngestStep(deps(), job);
    expect(started).toEqual([
      {
        scope: { userId: job.userId, accountId: expect.any(String), allowedCaseIds: [caseId] },
        caseId,
        storageKey: job.storageKey,
        mediaType: "application/pdf",
        filename: "FIR.pdf",
        attempt: 1,
      },
    ]);
    let next = nextJob();
    expect(next.delaySeconds).toBe(2);
    expect(next.job).toMatchObject({
      submitted: true,
      pollMs: 4000,
      deadline: null,
      queuedDeadline: new Date(clock.getTime() + QUEUED_TIMEOUT_MS).toISOString(),
    });
    expect((await row(id)).status).toBe("queued");

    onGet = async (docId) => status(docId, 1, "running");
    await runIngestStep(deps(), next.job);
    expect((await row(id)).status).toBe("processing");
    next = nextJob();
    expect([next.delaySeconds, next.job.pollMs]).toEqual([4, 8000]);
    // The attempt's deadline starts when it runs (#258).
    expect(next.job.deadline).toBe(new Date(clock.getTime() + ATTEMPT_TIMEOUT_MS).toISOString());
    for (const expected of [8, 16, 30]) {
      await runIngestStep(deps(), next.job);
      next = nextJob();
      expect(next.delaySeconds).toBe(expected);
    }
    expect(next.job.pollMs).toBe(30_000);

    onGet = async (docId) => status(docId, 1, "done");
    await runIngestStep(deps(), next.job);
    expect(queue.ingested).toEqual([]);
    expect(await row(id)).toMatchObject({
      status: "done",
      attempt: 1,
      error: null,
      flags: [],
      pages: 3,
      processed_at: clock,
    });
    // Each stage's outcome is logged for the attempt (FR-DOC-2).
    const stages = await pool.query(
      "SELECT stage, state FROM app.document_stages WHERE document_id = $1 AND attempt = 1 ORDER BY started_at, stage",
      [id],
    );
    expect(stages.rows).toHaveLength(7);
    expect(stages.rows.find((s) => s.stage === "ocr")?.state).toBe("skipped");
  });

  it("flagged: keeps the flags and is never shown as clean (FR-DOC-4)", async () => {
    const { id, job } = await uploaded();
    onStart = async (docId) => status(docId, 1, "flagged", { flags: [FLAG] });
    await runIngestStep(deps(), job);
    expect(await row(id)).toMatchObject({ status: "flagged", flags: [FLAG], error: null });
    expect(queue.ingested).toEqual([]);
  });

  it("a retryable failure is retried as the next attempt, showing processing meanwhile", async () => {
    const { id, job } = await uploaded();
    await runIngestStep(deps(), job);
    const poll = nextJob().job;
    onGet = async (docId) => status(docId, 1, "failed", { error: "Timed out.", retryable: true });
    await runIngestStep(deps(), poll);
    expect(await row(id)).toMatchObject({ status: "processing", attempt: 2 });
    const retry = nextJob();
    expect(retry.delaySeconds).toBe(30);
    expect(retry.job).toMatchObject({ attempt: 2, firstAttempt: 1, submitted: false });

    onStart = async (docId) => status(docId, 2, "done");
    await runIngestStep(deps(), retry.job);
    expect(started.map((r) => r.attempt)).toEqual([1, 2]);
    expect(await row(id)).toMatchObject({ status: "done", attempt: 2 });
  });

  it("after the last attempt the document is failed, with the error, never dropped", async () => {
    const { id, job } = await uploaded();
    onStart = async (docId, req) =>
      status(docId, req.attempt, "failed", { error: "Timed out.", retryable: true });
    let next: IngestJob = job;
    for (const attempt of [1, 2]) {
      await runIngestStep(deps(), next);
      expect(await row(id)).toMatchObject({ status: "processing", attempt: attempt + 1 });
      next = nextJob().job;
    }
    await runIngestStep(deps(), next);
    expect(queue.ingested).toEqual([]);
    expect(await row(id)).toMatchObject({
      status: "failed",
      attempt: 3,
      error: "Timed out.",
      processed_at: clock,
    });
  });

  it("a failure that can't be retried is failed at once", async () => {
    const { id, job } = await uploaded();
    onStart = async (docId) =>
      status(docId, 1, "failed", { error: "The file is encrypted.", retryable: false });
    await runIngestStep(deps(), job);
    expect(await row(id)).toMatchObject({ status: "failed", error: "The file is encrypted." });
    expect(queue.ingested).toEqual([]);
  });

  it("services/ai unreachable: retried, then failed with a message for the user", async () => {
    const { id, job } = await uploaded();
    onStart = async () => {
      throw new AiHttpError("/ai/v1/documents/x/ingestion", 503);
    };
    let next: IngestJob = job;
    for (let i = 0; i < 2; i++) {
      await runIngestStep(deps(), next);
      next = nextJob().job;
    }
    await runIngestStep(deps(), next);
    expect(await row(id)).toMatchObject({ status: "failed", error: MESSAGES.unavailable });
  });

  it("a 400 from services/ai fails the document without retrying", async () => {
    const { id, job } = await uploaded();
    onStart = async () => {
      throw new AiHttpError("/ai/v1/documents/x/ingestion", 400);
    };
    await runIngestStep(deps(), job);
    expect(await row(id)).toMatchObject({ status: "failed", error: MESSAGES.rejected });
    expect(queue.ingested).toEqual([]);
  });

  it("a poll that errors is retried later; a 404 submits again", async () => {
    const { id, job } = await uploaded();
    await runIngestStep(deps(), job);
    const poll = nextJob().job;
    onGet = async () => {
      throw new Error("connection reset");
    };
    await runIngestStep(deps(), poll);
    expect(nextJob().job).toMatchObject({ submitted: true, pollMs: 8000 });
    onGet = async () => {
      throw new AiHttpError("/ai/v1/documents/x/ingestion", 404);
    };
    await runIngestStep(deps(), poll);
    expect(nextJob().job).toMatchObject({ submitted: false, attempt: 1 });
    expect((await row(id)).status).toBe("queued");
  });

  const minutes = (n: number) => new Date(clock.getTime() + n * 60_000);

  it("an attempt running past its deadline counts as a retryable failure", async () => {
    const { id, job } = await uploaded();
    await runIngestStep(deps(), job);
    onGet = async (docId) => status(docId, 1, "running");
    await runIngestStep(deps(), nextJob().job);
    const poll = nextJob().job;
    clock = new Date(clock.getTime() + ATTEMPT_TIMEOUT_MS + 1);
    await runIngestStep(deps(), poll);
    expect(await row(id)).toMatchObject({ status: "processing", attempt: 2 });
    expect(nextJob().job).toMatchObject({ attempt: 2, deadline: null, queuedDeadline: null });
  });

  it("time spent queued in services/ai doesn't count against the attempt (#258)", async () => {
    const { id, job } = await uploaded();
    await runIngestStep(deps(), job);
    onGet = async (docId) => status(docId, 1, "queued");
    clock = minutes(40);
    await runIngestStep(deps(), nextJob().job);
    expect(await row(id)).toMatchObject({ status: "queued", attempt: 1 });
    onGet = async (docId) => status(docId, 1, "running");
    await runIngestStep(deps(), nextJob().job);
    // 20 minutes into the run, 60 after submit: still within the attempt.
    clock = minutes(20);
    await runIngestStep(deps(), nextJob().job);
    expect(await row(id)).toMatchObject({ status: "processing", attempt: 1 });
    onGet = async (docId) => status(docId, 1, "done");
    await runIngestStep(deps(), nextJob().job);
    expect(await row(id)).toMatchObject({ status: "done", attempt: 1 });
  });

  it("an attempt queued past the queue limit is failed as timed out, then retried", async () => {
    const { id, job } = await uploaded();
    await runIngestStep(deps(), job);
    onGet = async (docId) => status(docId, 1, "queued");
    clock = new Date(clock.getTime() + QUEUED_TIMEOUT_MS + 1);
    await runIngestStep(deps(), nextJob().job);
    expect(await row(id)).toMatchObject({ status: "processing", attempt: 2 });
    expect(nextJob().job).toMatchObject({ attempt: 2, submitted: false });
  });

  it("the last attempt queued past the limit leaves the document failed (NFR-13)", async () => {
    const { id, job } = await uploaded();
    await pool.query("UPDATE app.documents SET attempt = 3 WHERE id = $1", [id]);
    await runIngestStep(deps(), {
      ...job,
      attempt: 3,
      firstAttempt: 1,
      submitted: true,
      deadline: null,
      queuedDeadline: new Date(clock.getTime() - 1).toISOString(),
    });
    expect(await row(id)).toMatchObject({ status: "failed", error: MESSAGES.timeout });
    expect(queue.ingested).toEqual([]);
  });

  it("a job enqueued before #258 (deadline from submit, no queue limit) still times out", async () => {
    const { id, job } = await uploaded();
    const legacy = {
      ...job,
      submitted: true,
      deadline: new Date(clock.getTime() + ATTEMPT_TIMEOUT_MS).toISOString(),
    } as IngestJob;
    delete legacy.queuedDeadline;
    onGet = async (docId) => status(docId, 1, "running");
    await runIngestStep(deps(), legacy);
    expect(nextJob().job.deadline).toBe(legacy.deadline);
    clock = new Date(clock.getTime() + ATTEMPT_TIMEOUT_MS + 1);
    await runIngestStep(deps(), legacy);
    expect(await row(id)).toMatchObject({ status: "processing", attempt: 2 });
  });

  it("stops when the document was deleted or a newer attempt took over", async () => {
    const { id, job } = await uploaded();
    await pool.query("UPDATE app.documents SET attempt = 2 WHERE id = $1", [id]);
    await runIngestStep(deps(), job);
    expect(started).toEqual([]);
    await pool.query("UPDATE app.documents SET attempt = 1, deleted_at = now() WHERE id = $1", [
      id,
    ]);
    await runIngestStep(deps(), job);
    expect(started).toEqual([]);
    expect(queue.ingested).toEqual([]);
  });

  it("only a status change moves updatedAt", async () => {
    const { id, job } = await uploaded();
    const updatedAt = async () =>
      (await pool.query("SELECT updated_at FROM app.documents WHERE id = $1", [id])).rows[0]
        .updated_at as Date;
    await runIngestStep(deps(), job);
    const poll = nextJob().job;
    const queuedAt = await updatedAt();
    onGet = async (docId) => status(docId, 1, "queued");
    await runIngestStep(deps(), poll);
    expect(await updatedAt()).toEqual(queuedAt);
    nextJob();
    onGet = async (docId) => status(docId, 1, "running");
    await runIngestStep(deps(), poll);
    expect((await updatedAt()).getTime()).toBeGreaterThan(queuedAt.getTime());
  });

  describe("purge", () => {
    it("removes the chunks in services/ai, the file and the row", async () => {
      const { id, job } = await uploaded();
      const purged: string[] = [];
      onPurge = async (docId) => void purged.push(docId);
      expect(storage.blobs.has(job.storageKey)).toBe(true);
      await runPurge({ db, ai, storage }, job);
      expect(purged).toEqual([id]);
      expect(storage.blobs.has(job.storageKey)).toBe(false);
      expect(await row(id)).toBeUndefined();
      // Again: nothing left, and nothing fails.
      await runPurge({ db, ai, storage }, job);
    });

    it("keeps the file and the row when services/ai is down, so the retry can finish", async () => {
      const { id, job } = await uploaded();
      onPurge = async () => {
        throw new AiHttpError("/ai/v1/documents/x", 503);
      };
      await expect(runPurge({ db, ai, storage }, job)).rejects.toThrow(AiHttpError);
      expect(storage.blobs.has(job.storageKey)).toBe(true);
      expect(await row(id)).toBeDefined();
    });

    it("treats a 404 from services/ai as nothing to purge", async () => {
      const { id, job } = await uploaded();
      onPurge = async () => {
        throw new AiHttpError("/ai/v1/documents/x", 404);
      };
      await runPurge({ db, ai, storage }, job);
      expect(await row(id)).toBeUndefined();
    });
  });
});
