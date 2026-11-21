// Test doubles for the document dependencies of createApp (#101).
import { Readable } from "node:stream";
import type { AiClient } from "../src/clients/ai.js";
import type { IngestJob, JobQueue, PurgeJob } from "../src/jobs/queue.js";
import { BlobNotFound, type BlobStore } from "../src/storage/blob-store.js";

/** An in-memory blob store; `blobs` is inspectable. */
export function memoryStore(): BlobStore & { blobs: Map<string, Buffer> } {
  const blobs = new Map<string, Buffer>();
  return {
    blobs,
    async put(key, data) {
      blobs.set(key, Buffer.from(data));
    },
    async get(key) {
      const data = blobs.get(key);
      if (!data) throw new BlobNotFound(key);
      return Readable.from([data]);
    },
    async delete(key) {
      blobs.delete(key);
    },
    async deletePrefix(prefix) {
      for (const key of blobs.keys()) if (key.startsWith(`${prefix}/`)) blobs.delete(key);
    },
  };
}

/** A queue that records what was enqueued instead of running it. */
export function recordingQueue(): JobQueue & {
  ingested: { job: IngestJob; delaySeconds: number }[];
  purged: PurgeJob[];
} {
  const ingested: { job: IngestJob; delaySeconds: number }[] = [];
  const purged: PurgeJob[] = [];
  return {
    ingested,
    purged,
    async ingest(job, delaySeconds = 0) {
      ingested.push({ job, delaySeconds });
    },
    async purge(job) {
      purged.push(job);
    },
  };
}

/** The createApp fields that tests of other routes don't care about. */
export const documentDeps = () => ({ storage: memoryStore(), jobs: recordingQueue() });

const unused = async (): Promise<never> => {
  throw new Error("not used");
};

/** The ingestion (and precedent) methods of AiClient, for stubs that don't use them. */
export const noIngestion: Pick<
  AiClient,
  | "startIngestion"
  | "getIngestion"
  | "purgeDocument"
  | "searchPrecedents"
  | "getPrecedentRelationships"
> = {
  startIngestion: unused,
  getIngestion: unused,
  purgeDocument: unused,
  searchPrecedents: unused,
  getPrecedentRelationships: unused,
};
