# Research 0002: options for storing user uploads (dev and demo)

- **Ticket:** [#144](https://github.com/CaseGuard-AI/CaseGuard/issues/144) (parent map [#137](https://github.com/CaseGuard-AI/CaseGuard/issues/137)). The decision is made in [#145](https://github.com/CaseGuard-AI/CaseGuard/issues/145), "Where do user uploads live, and how does a user reach them?".
- **Feeds:** [#101](https://github.com/CaseGuard-AI/CaseGuard/issues/101), document uploads, storage and the job queue (API).
- **Sources checked:** 2026-11-09. All limits and statuses below are as of that date. Re-check them before you rely on them.
- **Scope:** facts first. The last section is a **recommendation** for #145 to accept or reject. It is not a decision.

## 1. What the store has to satisfy

From the repo, as of 2026-11-09:

| Source | Constraint on storage |
|---|---|
| PRD FR-DOC-1 | PDF, DOCX and image/scanned files only. Default size limit 25 MB. |
| PRD FR-DOC-2, FR-DOC-3, NFR-13 | Processing is asynchronous (OCR, extract, clean, structure, chunk, embed, index) and has a status. Failures are flagged and retried, never dropped. The original must still be there when a retry runs. |
| PRD FR-DOC-6, FR-CASE-6, SEC-8 | Owner only, within one case. Other users' data is never retrievable. Marker-document test blocks release. |
| PRD SEC-6, #101 | Type and size limits, **stored outside the web root**, processed off the request path. Malware scanning is P2. |
| PRD SEC-4 | Already uses AES-256-GCM with a key from the environment, for user API keys. That pattern exists if uploads need app-level encryption. |
| PRD §14.1 | The diagram shows "file storage (originals)" beside Postgres. §14.3 says jobs run on a Postgres-backed queue (e.g. pg-boss), and infra is Docker Compose in dev with the cloud provider deferred. |
| ADR-0002 | `apps/api` owns uploads, documents and **the access decision**. `services/ai` is internal only and receives already-scoped requests (`user_id`, `account_id`, `allowed_case_ids`). Ingestion workers live in `services/ai`. |
| `docker-compose.yml` | Networks: `edge` (web, api, db, mailpit), `internal` (api, ai, db; `internal: true`, no outside access), `ai-egress` (ai only, outbound internet). `ai` publishes no port. The only volume is `pgdata`. |
| `docs/engineering/local-setup.md` | Day-to-day dev runs api and ai **natively on Windows** (`pnpm dev`). Docker is optional, except for the DB in most setups. |

Gaps in the PRD:

- It has **no explicit "delete case" or "delete user" requirement.** FR-CASE-1 says "create, edit, list and archive". Deletion behaviour is still worth designing now, because a key layout chosen today decides how cheap deletion is later (see §5.5).
- No upload code exists yet. A grep of `apps/api/src` and `services/ai/src` for upload, storage or blob found nothing.

## 2. Options at a glance

| | **A. Local disk / Docker volume** | **B. MinIO (community)** | **C. Garage** | **D. SeaweedFS** | **E. Cloudflare R2** | **F. Supabase Storage** |
|---|---|---|---|---|---|---|
| Where | Dev and a single-VM demo | Dev (docker-compose) | Dev, or self-hosted demo | Dev, or self-hosted demo | Hosted demo | Hosted demo |
| Status, 2026-11-09 | n/a | **Repo archived and read-only. Source-only distribution, no official images.** [1][2][3] | Active. v2.5.0 released 2026-10-24 [8] | Active. Release 4.53 on 2026-11-08 [10] | GA | GA |
| Licence | n/a | AGPL-3.0 [1]. Successor "AIStor Free" is commercially licensed, single node, redistribution prohibited [4] | AGPL-3.0 [8] | Apache-2.0 [10] | Proprietary service | Proprietary service |
| Free limits | Disk only | Disk only | Disk only | Disk only | 10 GB-month storage, 1M Class A ops, 10M Class B ops per month, **egress free** [11] | 1 GB storage, 5 GB egress, **50 MB max file**, 2 free projects, **paused after 1 week of inactivity** [16][17][18] |
| Card needed | No | No | No | No | Enabling R2 goes through a checkout flow, and Cloudflare billing requires a valid payment method to enable subscriptions [12][13] | Not stated in the docs read |
| Encryption at rest | None by the app. Relies on host disk encryption | SSE (KMS needed) | **No SSE-S3.** SSE-C listed as implemented [7] | Not checked | **AES-256, GCM mode, always on** [14] | AES-256 on all customer data, per security page and DPA [19][20] |
| Owner-only download | API streams | API streams, or presigned URL | API streams, or presigned URL [7] | API streams, or presigned URL | API streams, or presigned URL (1 s to 7 days; S3 domain only, **not on custom domains**) [15] | API streams, or signed URL (cannot be revoked one at a time) [21] |
| How `ai` reads the file | Same volume mounted read-only, or same host directory when native | S3 GET over `internal` | S3 GET over `internal` | S3 GET over `internal` | S3 GET over `ai-egress` with a read-only bucket-scoped token [22] | S3 GET over `ai-egress` [23] |
| Delete | `rm` of a file or directory | DeleteObject(s) | DeleteObjects [7] | DeleteObjects | DeleteObjects | DeleteObjects [23] |
| Windows dev | Best. Works natively and in Docker | Must build the image from source [2][3] | One container, `--single-node --default-bucket` [9] | One container (`weed mini`) [10] | Needs internet and an account | Needs internet and an account |
| Extra moving parts | None | One container, self-built | One container plus `garage.toml` | One container | Account, token, bucket | Project, keys, S3 enabled |

## 3. The options in detail

### A. Local disk or a Docker named volume, outside the web root

- **What it is.** The API writes each upload under a directory that no HTTP route serves, for example `UPLOAD_DIR=/data/uploads` in a container, or a git-ignored folder when run natively. SEC-6 and #101 ask for exactly this. Neither `apps/web` (Next.js) nor `apps/api` has a static-file route today, so "outside the web root" means: do not put it under `apps/web/public`, and do not mount it on an `express.static` path.
- **Sharing with `ai`.** Docker documents that "a given volume can be mounted into multiple containers simultaneously", and that one volume can be read-write in one container and read-only (`:ro`) in another [5]. So `api` could mount `uploads:/data/uploads` and `ai` could mount `uploads:/data/uploads:ro`. This needs no network path, which fits ADR-0002: `ai` gets no new port, and the file never leaves the `internal` trust zone. Natively on Windows, both processes just point at the same directory.
- **Persistence.** Named volumes outlive their containers. They go only with an explicit `docker volume rm` or prune [5], the same as `pgdata` today.
- **Windows.** Docker documents that bind mounts from the Windows filesystem (`/mnt/c/...`) are much slower than files on the Linux side, and that inotify events don't cross over [6]. A **named volume** lives on the Linux side, so it avoids that cost. A bind mount of a Windows folder would pay it. Filenames: Windows forbids certain names (`CON`, `NUL`, ...) and characters (`< > : " / \ | ? *`) [24]. Storing under a server-generated key (a UUID), never the user's filename, removes the issue on every OS.
- **Encryption at rest.** None unless the host disk is encrypted (for example BitLocker), or the app encrypts before writing (see §5.3).
- **Limits.** One host only. Fine for dev, CI and a single-VM demo. A demo on PaaS hosting with ephemeral disks, or several API replicas, would need a real object store.

### B. MinIO community edition: no longer a sensible default

- The `minio/minio` repository is **archived** (read-only). The GitHub API reports `archived: true` and a last push on 2026-04-24 [1]. Its README states "THIS REPOSITORY IS NO LONGER MAINTAINED" and that the community edition is "now distributed as source code only" [2].
- The last GitHub release is `RELEASE.2025-10-15T17-29-55Z`, published 2025-10-16 [1]. A MinIO maintainer confirmed on 2025-10-18 that no Docker image would be published: "This project is a source only distribution now, if you want to build containers you need to build them yourselves" [3]. Queried on 2026-11-09, Docker Hub's API returns **404** for `minio/minio`, so `image: minio/minio` in compose will not pull.
- The README now points to **AIStor**. MinIO's pricing page describes AIStor Free as "the full AIStor feature set for a single-node deployment", says AIStor "is commercially licensed", and states "Redistribution is prohibited" [4]. That is a proprietary licence for a university project, and the page didn't say whether a licence key or registration is needed.
- **Net:** using MinIO in 2026 means building an unmaintained AGPL server from source, or accepting a proprietary single-node licence. Either one costs more than options A, C or D.

### C. Garage (S3-compatible, self-hosted)

- AGPL-3.0, written in Rust. v2.5.0 was published 2026-10-24 [8].
- Single-node quick start: image `dxflrs/garage:v2.5.0`, with `/garage server --single-node --default-bucket`. It reads the access key, secret and bucket from `GARAGE_DEFAULT_*` env vars, so no manual layout, key or bucket commands are needed since v2.3.0. The sample config uses `replication_factor = 1` and `db_engine = "sqlite"`. The guide's own `docker run` has no persistent volume and "is not for production" [9]. A compose service would add a named volume.
- S3 coverage [7]: presigned URLs, DeleteObjects and partial lifecycle (expiration only) are implemented. **There is no SSE-S3 or bucket encryption**: "we did not implement server-side encryption for Garage". SSE-C is listed as implemented in the feature table.
- The S3 region is "often set just to `garage`". Clients must be configured for it, and for path-style or virtual-host access [25].
- The AGPL matters only if you modify Garage and offer it over a network. Running the unmodified image as an internal dependency has the same posture as running AGPL MinIO did.

### D. SeaweedFS (S3-compatible, self-hosted)

- Apache-2.0. Very active: release 4.53 on 2026-11-08 [10].
- The README documents a single-container S3 setup. It maps port 8333, mounts a data volume and sets access keys and a bucket by env var, with "Same behavior as the `weed mini` command" [10].
- SeaweedFS is a full distributed file system with many components. For one bucket of under 25 MB files, that is more surface than Garage. Its server-side encryption wasn't checked for this note.

### E. Cloudflare R2 (hosted, for the demo)

- **Free tier, monthly:** 10 GB-month of Standard storage, 1 million Class A operations (writes and lists), 10 million Class B operations (reads), and **free egress**. The free tier excludes Infrequent Access [11].
- **Account.** You enable R2 by completing "the checkout flow to add an R2 subscription" [12]. Cloudflare's billing policy says to "ensure that you are using a valid payment method before … enabling subscriptions" [13]. So expect to need a card on file even at $0 usage. This is a team-logistics point for #145.
- **Limits.** 5 GiB per single PUT and 5 TiB per object [26]. 25 MB uploads are far below both.
- **Encryption.** "Objects are encrypted using AES-256 … R2 uses GCM … as its preferred mode", always on. TLS in transit [14].
- **Presigned URLs.** GET, HEAD, PUT and DELETE are supported. POST form uploads are not. Expiry runs from 1 second to 7 days. They work **only on the S3 API domain, not on custom domains** [15].
- **Scoped credentials.** "Object Read only" and "Object Read & Write" tokens can be limited to specific buckets [22]. So `api` could get read-write, and `ai` read-only on the same bucket.
- **Reach.** Standard S3 API with SigV4, so the AWS SDK for JS (`@aws-sdk/client-s3`) and `boto3` both work, with an endpoint override. `ai` would reach it over the existing `ai-egress` network.

### F. Supabase Storage (hosted, for the demo)

- **Free plan:** 1 GB file storage, 5 GB egress, **50 MB maximum upload size**, two free projects, and "Free projects are paused after 1 week of inactivity" [16][17][18]. A demo idle for a week before a viva would need un-pausing.
- **Encryption.** "All customer data is encrypted at rest with AES-256" [19]. The DPA says "All hard disks are encrypted-at-rest using the industry-standard AES-256 algorithm" [20].
- **Access.** Private buckets are default-deny, through RLS on `storage.objects`. "Service keys entirely bypass RLS policies" [27]. CaseGuard does its own access decision in Express, so it would use the service key server-side and ignore RLS. Signed URLs can't be revoked one at a time, only by deleting or moving the object or rotating the signing key [21].
- **S3 protocol.** "Supabase Storage is compatible with the S3 protocol". GetObject (with ranges), PutObject, DeleteObjects and SigV4 presigning are supported, once the S3 connection is turned on in Storage settings [23]. So the same S3 driver as R2 would work.
- Supabase is a whole Postgres platform. CaseGuard would use only its storage, but would still be bound by the project-level pause.

## 4. Owner-only access: API streams vs short-lived presigned URLs

| | API streams the file | Short-lived presigned URL |
|---|---|---|
| Access check | On **every** request, in Express, with the same code path as all other owner checks (ADR-0002, SEC-2) | Once, when the URL is minted. After that, anyone holding the URL can fetch it until it expires. AWS: the URL grants "time-limited permission" with the signer's credentials [28] |
| Revocation | Immediate (session or ownership change) | None before expiry. Supabase: no per-URL revocation [21] |
| Store exposure | The store stays on `internal`, or is reached only by the server. The browser never talks to it | The browser must reach the store's S3 endpoint. In dev that means publishing the store's port and adding it to `edge`. On R2, the URL must use the `r2.cloudflarestorage.com` S3 domain, not a custom domain [15] |
| Audit | The API logs each download | Mint events only. The fetch is invisible to the app |
| Cost | Bytes pass through the API process. At ≤25 MB and demo traffic, this is negligible with Node streams | Offloads bandwidth from the API |
| Works with local disk | Yes | No (no URL signer) |

Uploads have the same split: through the API (multipart, then the API writes to the store), or a presigned PUT straight from the browser. Through the API, FR-DOC-1's type and size checks run before anything is stored. With a presigned PUT, the object lands first and has to be validated and possibly deleted afterwards.

## 5. Cross-cutting facts

### 5.1 How both backends reach the file under ADR-0002

The access decision stays in Express, so `ai` never decides *whether* a file may be read. It is told *which* file to read. Options:

1. **Shared store, key in the job.** The API stores the file, writes the `app.documents` row, and enqueues a job carrying `{document_id, user_id, case_id, storage_key}`. The worker in `ai` reads by key: from the shared volume (`:ro`) in option A, or with a read-only token in options C to F. This matches the ADR's "already-scoped request" model, and adds no new network edge.
2. **Presigned GET in the job.** The same as 1, but the job carries a URL that expires in minutes, so `ai` needs no store credentials. The catch: the URL must still be valid when a *retry* runs (NFR-13). Retries hours later would need the URL re-minted, which is a call from `ai` back to `api`.
3. **`ai` calls an internal API endpoint for the bytes.** This reverses today's direction (`api` reaches `ai`, never the reverse) and needs a second service token. Possible, but it widens the boundary.
4. **API pushes the bytes to `/ai/v1`.** Synchronous, and the bytes travel even if the job later retries. Clashes with "processed off the request path" unless the API itself runs as a job.

Note: pg-boss is a Node library. How a Python worker in `services/ai` consumes jobs from it (or from a Python-side equivalent on the same Postgres) is a **separate question**, not answered here. It doesn't change the storage options above.

### 5.2 Key layout

A key such as `users/{user_id}/cases/{case_id}/{document_id}` (UUIDs, with the original filename and MIME type kept in Postgres) gives you:

- no path traversal and no Windows filename problems [24], because the user never chooses the path;
- delete-by-prefix for a case or a user, as `rm -r` on disk or list-and-DeleteObjects on S3 [7][23];
- a quick visual check in tests that a user's files sit under that user only.

The ownership check must still come from the database row, never from parsing the key.

### 5.3 Encryption at rest

- **Hosted stores:** R2 [14] and Supabase [19][20] encrypt at rest by default with AES-256. Nothing to build.
- **Local disk and Garage:** no server-side encryption [7]. Options: rely on host disk encryption (BitLocker or LUKS on the demo VM), or use **app-level envelope encryption** with AES-256-GCM, mirroring SEC-4. App-level encryption works the same on every driver. But under ADR-0002, `ai` would then need the decryption key too, or would have to receive plaintext from `api`. That is a boundary decision for #145.
- Dev data is meant to be synthetic, so dev encryption is a lower priority than for the demo.

### 5.4 Fit with a Postgres-backed queue (pg-boss)

- The file must be stored durably **before** the job is enqueued, and must not be deleted until the job reaches a terminal state, or retries would find nothing (NFR-13).
- Insert the `documents` row (status `queued`) and the job in one DB transaction, after the bytes are written. The two can then never disagree. An orphaned file from a crash between write and commit can be swept later by a "files with no row" job. This is the same on every driver.
- Job payloads carry IDs and keys, never file bytes.

### 5.5 Deletion when a case or user is deleted

- The PRD doesn't yet require hard deletion (FR-CASE-1 says *archive*). If it is added:
  - Delete or mark the DB rows, then delete the objects. Database deletes are transactional, but store deletes are not, so a retryable "purge" job (on the same queue) that deletes by prefix is the robust pattern on every driver.
  - Derived data in `corpus` and `ai` (chunks, embeddings, graph facts from the document) belongs to `services/ai` under ADR-0002 single-writer rules. Deleting it needs a scoped `/ai/v1` call or job. Removing the original file alone is not enough for FR-CASE-6 and SEC-8.
- Garage lifecycle supports expiration only [7]. R2 and Supabase deletes are ordinary S3 deletes. Nothing here depends on lifecycle rules.

### 5.6 A storage abstraction so dev and demo can differ

All the S3-compatible options (B to F) speak the same API. The AWS SDK presigning shown for S3 [28] applies, with an endpoint override, to R2 [15], Supabase [23] and Garage [7]. So two drivers cover all six options:

```ts
// apps/api — illustrative only
interface BlobStore {
  put(key: string, body: Readable, meta: { contentType: string; size: number }): Promise<void>;
  get(key: string): Promise<Readable>;        // used by the API's download route
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>; // case or user purge
}
// drivers: FsBlobStore(UPLOAD_DIR) | S3BlobStore({ endpoint, region, bucket, forcePathStyle, credentials })
```

`services/ai` needs a mirror with only `get(key)`: a `pathlib` read or `boto3.get_object`. It is chosen by env vars such as `STORAGE_DRIVER=fs|s3`, `UPLOAD_DIR`, `S3_ENDPOINT`, `S3_BUCKET` and `S3_REGION`, with credentials per service. Contract tests can run both drivers. In CI, the S3 driver could run against a Garage or SeaweedFS container.

## 6. Recommendation (for #145 to accept or reject)

> **This is a recommendation, not a decision.**

1. **Introduce a `BlobStore` interface with two drivers (`fs`, `s3`)** in `apps/api`, plus a read-only mirror in `services/ai`, selected by `STORAGE_DRIVER`.
2. **Dev and CI: `fs` driver.** Use a git-ignored directory when run natively on Windows, and a named volume `uploads` in compose: `api` read-write, `ai` read-only. This needs no new service or port, keeps files inside the `internal` trust zone, satisfies SEC-6 "outside the web root", and is the best fit for the team's native-Windows workflow.
3. **Downloads: the API streams the file** after the owner check in Express on every request. No presigned URLs in P1. This keeps ADR-0002's single access decision, gives immediate revocation, logs every download, and needs no store port reachable from the browser. Uploads also go through the API, so FR-DOC-1's checks run before anything is stored.
4. **Worker access: the job carries `{document_id, user_id, case_id, storage_key}`** (§5.1, option 1). `ai` reads by key with read-only access.
5. **Hosted demo: `s3` driver on Cloudflare R2.** Its 10 GB free storage, free egress, always-on AES-256 at rest and bucket-scoped read-only tokens beat Supabase's 1 GB cap, 50 MB file cap and 7-day pause. The cost is a payment method on the Cloudflare account. If that is a blocker, Supabase Storage through its S3 endpoint is the fallback, with the same driver.
6. **Do not adopt MinIO.** It is archived, ships no images, and its successor is proprietary. If an S3 emulator is wanted locally or in CI to test the `s3` driver, prefer **Garage v2.5.0** single-node (smallest setup) or **SeaweedFS** (Apache-2.0).
7. **Key layout `users/{user_id}/cases/{case_id}/{document_id}`**, and a retryable purge job for deletion, which also cleans up `corpus`/`ai` derived data through `services/ai`.
8. **Open for #145:** whether to add app-level AES-256-GCM encryption for the `fs` and Garage paths, and if so, how `ai` gets plaintext under ADR-0002.

## Sources

All checked 2026-11-09.

1. GitHub API, `repos/minio/minio` (`archived: true`, licence AGPL-3.0, `pushed_at` 2026-04-24) and `repos/minio/minio/releases/latest` (`RELEASE.2025-10-15T17-29-55Z`, published 2025-10-16). https://api.github.com/repos/minio/minio
2. MinIO README ("This repository is no longer maintained", "Source-only distribution"). https://github.com/minio/minio
3. minio/minio issue #21647 "Docker release?", maintainer reply 2025-10-18. https://github.com/minio/minio/issues/21647 . Also observed: Docker Hub API `https://hub.docker.com/v2/repositories/minio/minio/` returns 404.
4. MinIO pricing and AIStor FAQ. https://www.min.io/pricing
5. Docker docs, Volumes. https://docs.docker.com/engine/storage/volumes/
6. Docker docs, WSL best practices. https://docs.docker.com/desktop/features/wsl/best-practices/
7. Garage, S3 compatibility status. https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/
8. crates.io, `garage` 2.5.0, licence AGPL-3.0, published 2026-10-24. https://crates.io/crates/garage
9. Garage quick start. https://garagehq.deuxfleurs.fr/documentation/quick-start/
10. SeaweedFS README, licence Apache-2.0; GitHub API latest release 4.53, 2026-11-08. https://github.com/seaweedfs/seaweedfs
11. Cloudflare R2 pricing. https://developers.cloudflare.com/r2/pricing/
12. Cloudflare R2 get started. https://developers.cloudflare.com/r2/get-started/
13. Cloudflare billing policy. https://developers.cloudflare.com/billing/understand/billing-policy/
14. Cloudflare R2 data security. https://developers.cloudflare.com/r2/reference/data-security/
15. Cloudflare R2 presigned URLs. https://developers.cloudflare.com/r2/api/s3/presigned-urls/
16. Supabase pricing. https://supabase.com/pricing
17. Supabase Storage file limits. https://supabase.com/docs/guides/storage/uploads/file-limits
18. Supabase billing. https://supabase.com/docs/guides/platform/billing-on-supabase
19. Supabase security. https://supabase.com/security
20. Supabase Data Processing Addendum (2025-03-14). https://supabase.com/downloads/docs/Supabase+DPA+250314.pdf
21. Supabase Storage, serving downloads and signed URLs. https://supabase.com/docs/guides/storage/serving/downloads
22. Cloudflare R2 API tokens. https://developers.cloudflare.com/r2/api/tokens/
23. Supabase Storage S3 compatibility. https://supabase.com/docs/guides/storage/s3/compatibility
24. Microsoft, Naming files, paths and namespaces. https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
25. Garage, connecting apps (region, path-style). https://garagehq.deuxfleurs.fr/documentation/connect/
26. Cloudflare R2 limits. https://developers.cloudflare.com/r2/platform/limits/
27. Supabase Storage access control. https://supabase.com/docs/guides/storage/security/access-control
28. AWS S3, sharing objects with presigned URLs. https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html
