# Evaluation test set (#22, PRD §11)

There are 100 extractive questions over the seed statutes: `dev.jsonl` (60) for development and `heldout.jsonl` (40) for the final measurement. Each split is half civil and half criminal, and 10% of each is unanswerable (FR-RES-9). No question appears in both splits.

```powershell
pnpm eval:testset -- check            # rows, balance, overlap, freeze hash
pnpm eval:testset -- check --corpus   # also resolve every gold section in the loaded corpus
pnpm eval:testset -- freeze           # write FROZEN.sha256 (once, before any tuning)
```

## Rows

| Field | Meaning |
|---|---|
| `id` | `dev-NNN` or `heldout-NNN` |
| `question` | The question in English |
| `domain` | `civil` or `criminal` |
| `answerable` | `false` when the corpus doesn't hold the answer |
| `gold` | `[{act, section, heading}]`, for example `{"act": "PPC", "section": "302", "heading": "Punishment of qatl-i-amd"}`. Act codes: `PPC`, `CrPC`, `CPC`, `CA` (Contract Act), `SRA` (Specific Relief Act), `LA` (Limitation Act), `QSO`, `FRDLA`, `PTLA` |
| `reference_answer` | A quote of the section's text, without footnote markers |
| `as_of` | The date for an as-of question, else `null` |
| `urdu`, `roman_urdu` | Other phrasings of the question. Always set with `needs_native_review: true` until a native speaker checks them (#105) |
| `absent_terms` | Unanswerable rows only: phrases that occur nowhere in the corpus |

The ground truth is mechanical (PRD §11), so no expert has to mark it. An answer is correct when it cites the gold section, and "not supported" is correct for an unanswerable question. `check --corpus` confirms each gold section by its number and heading in the act's text, then confirms the reference answer is there. It doesn't rely on the chunker's `section_id`.

## Not done yet
- **As-of questions:** PRD §11 asks for at least 8. They need the curated section versions (§10, M2), which don't exist yet, so `check` reports the gap rather than failing. Add them to `dev.jsonl` when the versions land. The held-out set is frozen before that, so it won't get any.
- **Urdu:** 15 rows have machine-written Urdu and Roman-Urdu. They wait for the native-speaker review (#105).

## Corpus check
`check --corpus` warns when no chunk carries a gold row's `section_id`: retrieval cites by it, so such a section can't be cited by number. Since #263 (corpus `eval-frozen-2`) there are no such warnings. Any that come back are a chunker regression.

## Freezing
1. The team skims both files.
2. `pnpm eval:testset -- freeze`, then commit `FROZEN.sha256`.
3. Tag that commit `eval-heldout-v1`, then `pnpm data:dump -- --freeze eval-frozen-N` so the corpus is pinned too (data-storage spec §4).

**Frozen on 2026-11-28.** `heldout.jsonl` has sha256 `74a663ef872e76065b3cee8245294d5fbee568d288b0a8a620a4526f2740a121`. The commit is tagged `eval-heldout-v1`, and the corpus is pinned as `dumps/2026-11-28-4` (tag `dump/eval-frozen-2`, AI migration `0003`, chunker version 2). Restore that corpus with `pnpm data:pull -- --dump eval-frozen-2` before a measured run, and record it in the run (PRD §11). It replaced `eval-frozen-1` (`dumps/2026-11-28-3`) the same day, before any measured run used it: #263 fixed the section ids that the earlier pin got wrong.

After the freeze, `check` fails if `heldout.jsonl` changes.
