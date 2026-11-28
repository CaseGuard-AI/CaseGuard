> **Status:** In progress · **Issue:** [#263](https://github.com/CaseGuard-AI/CaseGuard/issues/263)

# #263: statute chunks lack or mislabel `section_id`

## Context
Retrieval and citations go by `chunks.section_id`. In dump `2026-11-28-3`:
- None of the CrPC's or CPC's 772 chunks has a section id. They're cited as `para 442`, and the #192 run showed this.
- PPC ids `34`/`53`/`82`/`84`/`96` point to the contents entries for ss. 334/353/482/484/496.
- PPC s. 34 and s. 375 have no chunk of their own.

The frozen test set's `pnpm eval:testset -- check --corpus` warns on 20 gold sections. The goal is zero warnings, with every CrPC/CPC/PPC section citable by its number, and the fix published as a new pinned dump.

## Root causes (found while planning)
1. **CrPC/CPC are `kind='other'`, so the statute chunker never runs on them.** The collector's `guess_document_type` (`services/collector/extractors/metadata_extractor.py:188`) looks for `" code"` with a leading space. That misses titles that *start* with "Code of …", so both got `document_type: "unknown"`. `kind_of` (`services/ai/src/caseguard_ai/ingest/load.py:126`) then maps `unknown` to `other`. The statute chunker already handles the CrPC layout, a number alone on its line with the title below (`chunker.py:57`), and the CPC's First Schedule Orders. It just never got these documents.
2. **A reload would not even update `kind`.** `_CHANGED` (`load.py:230`) only rewrites a row when content_hash, title, url, headnote_only, third_party, snapshot or raw differ, and `kind` isn't in that list.
3. **The PPC's contents are read as body.** The PPC has no enacting formula, so `statute_sections` falls back to `_contents_end` (`chunker.py:200`). That function looks for the second `"1."` heading, but `_candidates` also yields footnote-stripped readings ("11." → "1", "21." → "1"). So the "second 1." it finds is around line 40, inside the contents, which really run from line 18 to 1475 (the body's `1.` is at line 1476). The contents' bare numbers then join the best run. The other six seed statutes have an enacting formula and never reach `_contents_end`.
4. **Re-chunking would cost a full re-embed.** A chunker change needs `CHUNKER_VERSION` bumped (`chunker.py:4`). That makes `chunk_pending` (`embed.py:151`) delete and rewrite the chunks of all 56k documents, and every embedding goes with them, so all 60k chunks would need bge-m3 again.

## Changes (one PR, branch `fix/263-statute-section-ids`)
1. **The collector type guess.** In `metadata_extractor.py::guess_document_type`, match whole words (`\bcode\b`, `\bact\b`, and so on) instead of space-prefixed needles, keeping the existing order. Test: `"Code of Criminal Procedure (CrPC), 1898"` and `"Code of Civil Procedure (CPC), 1908"` give `code`. Existing results ("Pakistan Penal Code", "… Act", "… Order") stay the same.
2. **The loader, defensively.** In `load.py::kind_of`, a record from a `LEGISLATION_SOURCES` source with type `unknown` or empty becomes `statute`, because Pakistan Code publishes only legislation. That fixes the stored seed records without re-scraping. Also add `kind` to `_CHANGED`, so a reload that changes only the kind updates the row and its `updated_at`, which marks the chunks stale. Tests in the existing load tests:
   - `kind_of(...)` gives `statute` for a `pakistan_code` record with type `unknown`, and a judgment source with type `unknown` still gives `other`.
   - Reloading a row whose only change is `kind` updates it.
3. **The chunker.** In `_contents_end`, count only headings as written (`not c.stripped`) when looking for the two `"1."` lines. Bump `CHUNKER_VERSION` to `"2"`. Test with a small PPC-shaped fixture: no enacting formula; contents of bare `N.` lines with titles below, including `11.`, `21.`, `34.` and `334.`; then a body with `1.`, `1[34. Acts done …`, `334.`, and `1500. Punishment for defamation`. Assert that the contents are excluded, and that ids `34`, `334` and `500` map to the body text of those sections.
4. **Keep embeddings across a re-chunk.** In `embed.py::chunk_pending`, before deleting a batch's chunks, read their `(document_id, text) → embedding`. Then insert each new chunk with the old embedding when its text is unchanged, so `embed_pending` embeds only chunks that are new or changed. With the version bump, the 56k judgments re-chunk to the same text and keep their vectors; only the changed statute chunks (about 1,500) need the model. Test with the hash embedder:
   - Chunk and embed a statute and a judgment.
   - Bump the version (monkeypatch `CHUNKER_VERSION`) and re-run.
   - The unchanged chunks keep their vectors and `chunks_embedded` counts only the changed ones.

## A local dry-run before any Colab work
A scratch script (not committed) loads the 9 seed statutes' `full_text` from the local DB and runs the new `chunk_document` in memory, with no embedding. Then, for each of the 90 gold rows in `eval/testset`, it checks that a chunk with `section_id` = gold section contains the gold heading, and it lists the CrPC/CPC/PPC section-id coverage. Target: 0 misses, and spot checks of CrPC 154/497/561A, CPC 9/11/115 and PPC 34/302/375/489F. If something is off, fix the chunker and add a test before going on.

## Running it on Colab (with you, after the PR merges)
1. Open the notebook on `staging` (step 3 now updates the clone) and run steps 1–5, which restore `latest` (`2026-11-28-3`).
2. Download the seed records with `snapshot_download("caseguard/corpus", allow_patterns=["snapshots/pk-code-seed/2026-11-10/documents/*"])`. Then `python -m caseguard_ai.ingest.load <dir>` with the same snapshot label as now (`local@2026-11-10`; check `load.py`'s flag), so only the kind changes. Expect 2 documents updated (CrPC, CPC).
3. `python -m caseguard_ai.ingest.embed`: re-chunk everything (version 2), reuse the unchanged vectors, embed about 1,500 chunks on the T4.
4. Check: `python -m caseguard_ai.eval.testset check --corpus` gives `ok` with 0 section_id warnings.
5. `python -m caseguard_ai.ingest.dump --freeze eval-frozen-2 --yes` publishes the next dump, and `latest` moves to it. Your HF token has write access.
6. Re-ask CrPC s. 497 through the tunnel: its citations should read `s. 497`, not `para 442`.

## Found while executing
- **Nested amendment marks.** PPC s. 375's heading is `3[2[375. Rape.__`, and `_SECTION_HEAD` allowed only one `N[` mark. It now allows up to two, so s. 375 gets its own chunk.
- **The dry-run passed, 90 of 90.** CrPC 618 of 620 chunks now carry a section id (505 distinct). CPC is 983 of 983, including `O.XXI.r.60`, and PPC is 634 of 634. Only QSO changed among the other six seed laws, and only in chunks without an id: four contents fragments, now dropped as intended, and the "WHEREAS" preamble, now before the body start. A small loss.

## Docs (a small follow-up PR)
- `eval/testset/README.md`: the corpus pin becomes `dump/eval-frozen-2`, replacing `eval-frozen-1`, which no measured run has used. Drop the "Corpus defects this surfaced" paragraph.
- The work-log entry, and the dump name in `session-handoff.md` and `stream-a-roadmap.md`.

## Verification
- services/ai and services/collector: ruff, mypy and pytest pass. Each new test fails on the old code.
- The local dry-run passes all 90 gold rows.
- On Colab, `check --corpus` gives 0 warnings, the new dump is published and `latest` points to it, and the s. 497 citations read `s. 497`.
- `pnpm data:pull -- --dump latest` on the laptop restores the new dump.
