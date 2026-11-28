> **Status:** Done (held-out frozen, tag `eval-heldout-v1`) · **Issue:** [#22](https://github.com/CaseGuard-AI/CaseGuard/issues/22) · **PR:** [#264](https://github.com/CaseGuard-AI/CaseGuard/pull/264)

# #22: evaluation test set (60 dev + 40 held-out)

## Context
PRD §11 needs a frozen test set before any tuning. The questions are extractive, half civil and half criminal, with about 10% unanswerable, and the ground truth has to be checkable mechanically. This is separate from #200, where the team marks judgments for the area classifier.

## Approach
- I wrote 90 answerable questions from the section text in the loaded corpus. They cover PPC, CrPC, QSO, the Contract Act, the Specific Relief Act, the Limitation Act, CPC, FRDLA and PTLA. There are also 10 off-corpus questions (Indian, UK and EU law, and the Pakistani PECA, Anti-Rape Act and Punjab Rented Premises Act), each with `absent_terms` that had 0 hits in `corpus.chunks`.
- Split: in each domain, positions 1 and 3 of every 5 go to held-out (18 of 45). Unanswerable questions split 3 to dev and 2 to held-out per domain.
- `caseguard_ai.eval.testset` (`pnpm eval:testset`) handles the checks and the freeze. `--corpus` resolves gold by the section number plus its heading in the act's text, and checks the reference answer's 5-gram coverage (≥ 60%). The coverage threshold allows for footnote markers and OCR slips, and the check doesn't rely on `section_id`.
- As-of questions are deferred until the curated versions exist (§10). The Urdu phrasings are flagged for #105.

## Verification
- `pnpm eval:testset -- check --corpus` against the 2026-11-28-2 dump: ok. All 90 gold sections resolve and all 10 absent terms are absent. The 20 warnings are sections with no `section_id` (CrPC, CPC, PPC s. 34).
- `tests/test_eval_testset.py` has 12 tests; services/ai ruff, mypy and pytest pass, apart from the PIL import that this branch doesn't touch.

## Follow-ups
- A chunker fix so CrPC/CPC get `section_id`s and footnote numbers aren't glued onto section numbers (#263).
- Freeze after the team skims it, then tag `eval-heldout-v1`.
