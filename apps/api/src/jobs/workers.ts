import type { PgBoss } from "pg-boss";
import { runIngestStep, type IngestDeps } from "./ingest.js";
import { runPurge, type PurgeDeps } from "./purge.js";
import { INGEST, PURGE, type IngestJob, type PurgeJob } from "./queue.js";

/** Runs the document workers in this process (WORKERS_ENABLED). */
export async function startWorkers(boss: PgBoss, deps: IngestDeps & PurgeDeps): Promise<void> {
  await boss.work<IngestJob>(INGEST, { localConcurrency: 4 }, async (jobs) => {
    for (const job of jobs) await runIngestStep(deps, job.data);
  });
  await boss.work<PurgeJob>(PURGE, async (jobs) => {
    for (const job of jobs) await runPurge(deps, job.data);
  });
}
