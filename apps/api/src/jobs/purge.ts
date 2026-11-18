// The document.purge job (data-storage §6): what services/ai holds, then the blob, then the row.
// Each step is idempotent, so pg-boss can retry the whole job until it succeeds.
import { AiHttpError, type AiClient } from "../clients/ai.js";
import type { Db } from "../db/client.js";
import { removeDocumentRow } from "../documents/store.js";
import type { BlobStore } from "../storage/blob-store.js";
import type { PurgeJob } from "./queue.js";

export interface PurgeDeps {
  db: Db;
  ai: AiClient;
  storage: BlobStore;
}

export async function runPurge(deps: PurgeDeps, job: PurgeJob): Promise<void> {
  try {
    await deps.ai.purgeDocument(job.documentId);
  } catch (err) {
    // purgeDocument answers 204 for an unknown document, so a 404 means there is nothing there to
    // purge (a services/ai without ingestion). Anything else is retried.
    if (!(err instanceof AiHttpError && err.status === 404)) throw err;
  }
  await deps.storage.delete(job.storageKey);
  await removeDocumentRow(deps.db, job.documentId);
}
