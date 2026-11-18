// The job queue (pg-boss on Postgres, PRD §11). Two queues (ADR-0010, data-storage §6):
//   document.ingest  one step of an ingestion: submit an attempt, or poll it once. Each step
//                    enqueues the next with a delay, so no worker is held while services/ai works.
//   document.purge   after a delete: the chunks in services/ai, then the blob, then the row.
import { PgBoss } from "pg-boss";
import type { Logger } from "../lib/logger.js";

export const INGEST = "document.ingest";
export const PURGE = "document.purge";

/** One step of a document's ingestion. Carries the keys of data-storage §6. */
export interface IngestJob {
  documentId: string;
  userId: string;
  caseId: string;
  storageKey: string;
  attempt: number;
  /** The attempt this run started at: automatic retries count from here (NFR-13). */
  firstAttempt: number;
  /** Whether `attempt` has been accepted by services/ai; then this step polls it. */
  submitted: boolean;
  /** The delay before the next poll; doubles up to 30 s. */
  pollMs: number;
  /** When polling this attempt gives up (ISO time); null until submitted. */
  deadline: string | null;
}

export interface PurgeJob {
  documentId: string;
  userId: string;
  caseId: string;
  storageKey: string;
}

export interface JobQueue {
  ingest(job: IngestJob, delaySeconds?: number): Promise<void>;
  purge(job: PurgeJob): Promise<void>;
}

/** A first ingest step for `attempt`. */
export const firstStep = (
  doc: { id: string; ownerUserId: string; caseId: string; storageKey: string },
  attempt: number,
): IngestJob => ({
  documentId: doc.id,
  userId: doc.ownerUserId,
  caseId: doc.caseId,
  storageKey: doc.storageKey,
  attempt,
  firstAttempt: attempt,
  submitted: false,
  pollMs: 2000,
  deadline: null,
});

/**
 * A started pg-boss on the `pgboss` schema. bootstrap.sql creates the schema; pg-boss creates
 * its tables in it (caseguard_app may not CREATE SCHEMA, ADR-0007).
 */
export async function startBoss(connectionString: string, logger: Logger): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, schema: "pgboss", createSchema: false });
  boss.on("error", (err) => logger.error({ err }, "job queue error"));
  await boss.start();
  // Unexpected errors in a step (the database, say) are retried by pg-boss; failures of the
  // processing itself are handled by the ingest step (NFR-13).
  await boss.createQueue(INGEST, { retryLimit: 5, retryDelay: 5, retryBackoff: true });
  // "Retried until it succeeds" (data-storage §6): about four days at up to an hour apart.
  await boss.createQueue(PURGE, {
    retryLimit: 100,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 3600,
  });
  return boss;
}

export function pgBossQueue(boss: PgBoss): JobQueue {
  return {
    async ingest(job, delaySeconds = 0) {
      await boss.send(INGEST, job, { startAfter: Math.ceil(delaySeconds) });
    },
    async purge(job) {
      await boss.send(PURGE, job);
    },
  };
}
