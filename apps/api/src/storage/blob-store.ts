// The blob store for uploaded files (data-storage §6). Files are reached only through the API,
// after the ownership check; there are no direct storage links. The key is all the store knows:
// `users/{userId}/cases/{caseId}/{documentId}`, never a filename.
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  /** The blob's bytes; rejects with BlobNotFound if there is none. */
  get(key: string): Promise<Readable>;
  /** Idempotent: a missing blob is not an error. */
  delete(key: string): Promise<void>;
  /** Removes every blob under `prefix/` (account deletion). Idempotent. */
  deletePrefix(prefix: string): Promise<void>;
}

export class BlobNotFound extends Error {
  constructor(readonly key: string) {
    super(`No blob at ${key}`);
  }
}

export const documentKey = (userId: string, caseId: string, documentId: string) =>
  `users/${userId}/cases/${caseId}/${documentId}`;

// Keys are built by documentKey from UUIDs; anything else is a bug, never a path to follow.
const KEY = /^[0-9a-z-]+(\/[0-9a-z-]+)*$/;

/** The `fs` driver: one file per key under `root` (a Compose volume, or a git-ignored folder). */
export function createFsBlobStore(root: string): BlobStore {
  const base = resolve(root);
  const pathOf = (key: string) => {
    if (!KEY.test(key)) throw new Error(`Invalid blob key: ${key}`);
    const path = join(base, ...key.split("/"));
    if (!path.startsWith(base + sep)) throw new Error(`Invalid blob key: ${key}`);
    return path;
  };

  return {
    async put(key, data) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      // Write then rename, so a reader never sees half a file. Readable by others: services/ai
      // runs as another user and reads the volume read-only. Only api and ai mount it.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, data, { mode: 0o644 });
      await rename(tmp, path);
    },
    async get(key) {
      const path = pathOf(key);
      try {
        if (!(await stat(path)).isFile()) throw new BlobNotFound(key);
      } catch (err) {
        if (err instanceof BlobNotFound || (err as NodeJS.ErrnoException).code === "ENOENT")
          throw new BlobNotFound(key);
        throw err;
      }
      return createReadStream(path);
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
    async deletePrefix(prefix) {
      await rm(pathOf(prefix), { recursive: true, force: true });
    },
  };
}
