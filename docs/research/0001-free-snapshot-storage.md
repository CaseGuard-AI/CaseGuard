# Research 0001: Free storage for corpus snapshots and corpus dumps

- **Ticket:** [#138](https://github.com/CaseGuard-AI/CaseGuard/issues/138) (map [#137](https://github.com/CaseGuard-AI/CaseGuard/issues/137)). The decision is made in [#142](https://github.com/CaseGuard-AI/CaseGuard/issues/142).
- **Date checked:** 2026-11-09. All sources below were read on this date. Free tiers change often, so check them again before relying on them.
- **Scope:** facts only. The recommendation at the end is marked as one and is not a decision.

## What we need to store

| Artifact | Contents | Expected size | Write pattern |
| --- | --- | --- | --- |
| Corpus snapshot | Collector output per partition: PDFs, extracted text, JSONL, and a SQLite crawl-state file | Several GB in total; many small files | Dated and immutable; a new snapshot never overwrites an old one |
| Corpus dump | `pg_dump` of the Postgres `corpus` schema, including pgvector bge-m3 1024-dim embeddings | About 1–3 GB, as one file | Dated and immutable |

Access: 3 students plus the supervisor (about 4 people), private, scriptable from Windows, resumable uploads, free tier only, no surprise egress charges.

## Comparison table

| Service | Free capacity | Per-file limit | Private to ~4 people? | Windows CLI / SDK, resumable | Egress / downloads | Card at sign-up | Versioning / immutability |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Hugging Face private dataset repo** (in a free org) | **100 GB private storage** per free user or org [HF1] | Hard cap 500 GB per file; under 200 GB recommended [HF1] | Yes. Free org with `read` / `write` / `admin` roles [HF2] | `hf upload` CLI and `huggingface_hub` Python. With `hf_xet`, uploads resume by re-running the same call, and already-uploaded chunks are deduplicated [HF3] | No egress fee documented. Free users get 5,000 resolver (download) requests per 5 min, counted per member [HF4] | None (free account) | Git commits on every change, plus tags. Not truly write-once: an admin can rewrite history (`super_squash_history`) [HF1] |
| **GitHub Releases** (private repo) | No total size limit [GH1] | **Each file under 2 GiB**; up to 1,000 assets per release [GH1] | Yes. Repo collaborators or org members | `gh release create/upload/download` | "no limit on … bandwidth usage" [GH1] | None | One release per date. Immutable releases lock the tag and the assets [GH2]; the docs do not say whether private repos or every plan can use them |
| **Cloudflare R2** | 10 GB-month of Standard storage; 1M Class A and 10M Class B operations per month [CF1] | 5 TiB per object; 5 GiB per single-part upload; 10,000 parts per multipart upload [CF2] | Yes, through scoped S3 API tokens | S3 API, so `rclone`, `aws s3`, and `boto3` all work, with multipart uploads | **Egress free** [CF1] | Not stated in the docs. Enabling R2 means completing a subscription "checkout flow" [CF3]; third-party guides say a card is asked for (unconfirmed) | Bucket locks give prefix-based retention, from N days to indefinite [CF4] |
| **Backblaze B2** | **First 10 GB free** [BB1] | Large-file (multipart) API; no free-tier cap found | Yes, through application keys | `b2` CLI, Python SDK, S3 API, `rclone` | Free up to 3× average monthly storage, then $0.01/GB [BB1]. Class D transactions: 2,500/day free [BB1] | **"No credit card required"** [BB2] | Keeps file versions [BB3]. Object Lock, 1–3,000 days, at no extra cost [BB4] |
| **Google Drive shared folder** (rclone) | 15 GB per Google account, shared with Gmail and Photos [GD1] | 5 TB per file; 750 GB uploaded per user per day [GD2] | Yes. Share the folder with 4 Google accounts | `rclone` uses chunked uploads (`chunk_size`). You must now create your own OAuth client ID, because the shared one "will stop working during 2026" [RC1] | No fee. About 10 queries/s per client ID [RC1] | None | Drive keeps revisions, but there is no write-once lock. Files sit in the owner's quota |
| **Supabase Storage** (Free plan) | **1 GB** file storage [SB1] | **50 MB** per upload [SB1] | Yes, through storage policies | `supabase-py`, S3 API | 5 GB egress plus 5 GB cached egress [SB1] | Not stated | None found. Free projects are **paused after 1 week of inactivity**; 2 active projects at most [SB1] |

## How each one fits

- **Hugging Face.** This is the only free option with room for several snapshots plus several 1–3 GB dumps: 100 GB. The PDFs need to be packed (per-partition `.tar`/`.zip`, or Parquet/JSONL). The docs recommend fewer than 100k files per repo and require fewer than 10k entries per folder [HF1]. The large-dataset section asks datasets to be "useful to the community" and to have a dataset card [HF1]. That section is about large public datasets. Our data is a few GB, private, and stays well inside the private quota, but this is a ToS point to keep in mind. Court judgments and statutes are public records, so storing them privately is low risk. We could not find a clause that forbids it.
- **GitHub Releases.** Bandwidth is unlimited and we already use the repo, so access control is already set up. But the 2 GiB per-file cap means a 1–3 GB dump has to be split (for example `split`, or `pg_dump -Fd` with several files), and snapshots have to be archived in pieces under 2 GiB. Release assets also live next to the code repo, mixing data into the code workflow.
- **Cloudflare R2.** It has the best egress terms (free) and real immutability (bucket locks). But 10 GB fills up after about one snapshot plus one or two dumps, and a payment method is probably needed to turn it on.
- **Backblaze B2.** It needs no card and has proper Object Lock. But 10 GB of storage is the same ceiling, and free egress is limited to 3× what we store.
- **Google Drive.** It is generous per file, but 15 GB is shared with each owner's Gmail. Uploads count against one person's quota, there is no immutability, and rclone now needs a self-made OAuth client.
- **Supabase.** It fails the requirements: 1 GB of storage and 50 MB per file. A corpus dump does not fit.

## Recommendation (for #142 to decide)

> **Recommendation:** Use a **private Hugging Face dataset repo owned by a free HF organization** (4 members) as the main store for corpus snapshots and corpus dumps.
> - Upload with `hf upload` / `upload_folder`, which resumes by re-running. Keep one dated folder per snapshot (`snapshots/2026-11-09/<partition>.tar.zst`, `dumps/2026-11-09/corpus.dump`). Add a git tag per release, and treat a published path as never rewritten. Give students `write` and the supervisor `read`.
> - Pack PDFs into per-partition archives so we stay under the file-count guidance.
> - Fallback if HF ToS or quota becomes a problem: **Backblaze B2** (no card, Object Lock), as long as we keep only the latest 1–2 snapshots under 10 GB. Or **GitHub Releases** if we split files to under 2 GiB.
> - Rule out Supabase (1 GB / 50 MB). Do not choose R2 unless someone is willing to put a card on file.

## Sources (all checked 2026-11-09)

- [HF1] Hugging Face, *Storage limits*: https://huggingface.co/docs/hub/storage-limits
- [HF2] Hugging Face, *Access control in organizations*: https://huggingface.co/docs/hub/organizations-security
- [HF3] Hugging Face, *Upload files to the Hub* (`hf_xet`, resumable uploads): https://huggingface.co/docs/huggingface_hub/main/en/guides/upload
- [HF4] Hugging Face, *Hub Rate limits*: https://huggingface.co/docs/hub/rate-limits
- [GH1] GitHub Docs, *About releases*: https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- [GH2] GitHub Docs, *Immutable releases*: https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases
- [CF1] Cloudflare, *R2 pricing*: https://developers.cloudflare.com/r2/pricing/
- [CF2] Cloudflare, *R2 limits*: https://developers.cloudflare.com/r2/platform/limits/
- [CF3] Cloudflare, *R2 get started*: https://developers.cloudflare.com/r2/get-started/
- [CF4] Cloudflare, *R2 bucket locks*: https://developers.cloudflare.com/r2/buckets/bucket-locks/
- [BB1] Backblaze, *B2 pricing*: https://www.backblaze.com/cloud-storage/pricing
- [BB2] Backblaze, *B2 sign-up*: https://www.backblaze.com/sign-up/b2-cloud-storage-backup-archive
- [BB3] Backblaze, *File versions*: https://www.backblaze.com/docs/cloud-storage-file-versions
- [BB4] Backblaze, *Object Lock*: https://www.backblaze.com/docs/cloud-storage-object-lock
- [GD1] Google One, *Plans* ("All Google accounts come with up to 15 GB of storage"): https://one.google.com/about/plans
- [GD2] Google Workspace, *Storage and upload limits*: https://knowledge.workspace.google.com/admin/drive/storage-and-upload-limits-for-google-workspace
- [RC1] rclone, *Google Drive backend*: https://rclone.org/drive/
- [SB1] Supabase, *Pricing*: https://supabase.com/pricing

### Gaps not resolved from primary sources

- Whether Cloudflare R2 requires a card: the official docs do not say.
- Whether GitHub immutable releases work on private repos on the Free plan: the docs do not say.
- Whether B2's free 10 GB comes with a daily download cap: a Backblaze help article quotes 1 GB/day for backup-linked B2. The current pricing page instead states the 3× egress rule.
