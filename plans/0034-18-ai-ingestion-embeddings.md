> **Status:** Done · **Issue:** [#18](https://github.com/CaseGuard-AI/CaseGuard/issues/18) · **PR:** [#167](https://github.com/CaseGuard-AI/CaseGuard/pull/167)

# #18: chunking, bge-m3 embeddings and FTS vectors

## Context

Handoff critical-path item 6, the "embed" step of load → embed → retrieve → answer. It needs the #15 tables and the #16 loader, both merged. ADR-0008 puts the embeddings in-process. The data-storage spec §4 requires a corpus to record its embedding model so retrieval and dumps (#154) can refuse a mismatch.

**Requirements:** FR-RES-2 (hybrid retrieval needs dense and sparse indexes), NFR-16 (the model is swappable and pinned), PRD §8.2 (chunking rules).

## Decisions

- **The chunker is pure and model-free** (`ingest/chunker.py`, `CHUNKER_VERSION = "1"`). Token counts are a words-and-punctuation estimate. bge-m3 reads 8,192 tokens, so exactness doesn't matter, and the same chunks come out whichever embedder is used.
- **Statute headings are chosen globally**, as the longest increasing run of section numbers (a weighted LIS), not by reading line by line. Why, from the live CPC, CrPC and Contract Act text:
  - the CrPC prints the number alone on its line (bare numbers are allowed only small steps);
  - footnote marks get glued to numbers ("125." is s. 25 + footnote 1, so stripped readings are allowed at a small penalty);
  - repeals leave gaps of up to 72 sections (the limit is 100), while years and in-section "1." lists are stray numbers;
  - Schedule II of the CrPC lists PPC section numbers, so the body ends at the first SCHEDULE heading;
  - the CPC's Orders restart their rules (ORDER headings are read in roman order).
- **Chunks never cross a section.** Long sections split at sub-sections ("s. 497(2)"), then at sentences.
- **Judgments** are paragraph windows of about 500 tokens with "paras 4-6" locators. **Head-note-only** records are a single "head-note" chunk, flagged.
- **The job is incremental and resumable.**
  - A document is re-chunked when it has no chunks, its chunks come from another chunker version, or it changed since (`chunks.created_at < documents.updated_at`).
  - A chunk is embedded when its embedding is NULL.
- **`corpus_meta` pins the model.**
  - The model and revision are written before any work. `built_at` is set only when a run finishes.
  - Another model or revision is refused unless `--rebuild` is given, which deletes the chunks first.
- **The models are pinned to HF revisions** in settings and `.env.example`: bge-m3 `5617a9f…`, and the reranker `953dc6f…` for #19.
- **torch comes from the CPU-only index** (`[tool.uv.sources]`). The default Linux wheel would add about 2.5 GB of CUDA to the image and CI. GPU users install a CUDA build locally (README).
- **`HashEmbedder`** (feature hashing) lets tests and CI run with no download.

## Verification

- `ruff` and strict `mypy` are clean. `pytest` gives 104 passed, 2 skipped (they need `DATABASE_URL` / `APP_TEST_DATABASE_URL`, set in CI).
  - `tests/test_chunker.py` (17) uses texts that copy the live layouts: contents, footnotes, bare numbers, `124A.`, `5[26.`, a stray year, a "1." list, Orders, schedules, the Constitution's articles, judgments and head-notes.
  - `tests/test_embed.py` (8, DB):
    - every document chunked, embedded and indexed;
    - `corpus_meta` written, and a re-run is a no-op;
    - only a changed document is re-chunked;
    - a stopped run is finished by the next;
    - a chunker version bump re-chunks everything;
    - another model is refused and `--rebuild` works;
    - the nearest neighbour by cosine and the FTS match are the right sections.
- **Live statutes from #153's `pk-code-seed` run:**
  - CPC: 158 of 159 sections found (s. 110 is repealed) and all 51 Orders;
  - CrPC: up to s. 565, and the gaps are the 1972 repeals (e.g. ss. 266–336);
  - Contract Act: all 238 sections except ss. 76–123, which were repealed by the Sale of Goods Act;
  - the largest chunk is 600 estimated tokens.
- **Real bge-m3 run:** still to do; the team runs it on the live crawls (see the PR).
