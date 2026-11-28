"""``python -m caseguard_ai.taxonomy.classify`` (``pnpm ai:classify-areas``), #200.

- default: label every judgment in ``corpus.documents``, writing ``area``, ``subcategory`` and
  ``raw.area_label`` (evidence, confidence, ``taxonomy_version``). Other ``raw`` keys are kept.
  Rows whose label is unchanged are not written, so a re-run changes nothing.
- ``--dry-run``: the same pass without writing; prints the area distribution.
- ``--sample N --out review.csv``: the stratified hand-labelling sample (doc §6).
- ``--score review.csv``: precision/recall per area from the filled sample. No database.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, Engine, create_engine, text

from caseguard_ai.config import DatabaseSettings
from caseguard_ai.taxonomy.classify import AreaLabel, Classifier
from caseguard_ai.taxonomy.review import (
    Candidate,
    format_score,
    read_sample,
    score,
    stratified,
    write_sample,
)
from caseguard_ai.taxonomy.rules import UNCLASSIFIED, Taxonomy, load_taxonomy

_ZERO = uuid.UUID(int=0)
_COLUMNS = (
    "id, collector_id, title, case_number, proceeding_type, matter_type, court, official_url,"
    " full_text, summary, raw->>'head_note' AS head_note, raw->'cited_laws' AS cited_laws,"
    " raw->>'seat' AS seat, headnote_only, area, subcategory, raw->'area_label' AS area_label"
)
_PAGE = text(
    f"SELECT {_COLUMNS} FROM corpus.documents"  # noqa: S608 (constant columns)
    " WHERE kind = 'judgment' AND id > :after ORDER BY id LIMIT :n"
)
_BY_IDS = text(f"SELECT {_COLUMNS} FROM corpus.documents WHERE id = ANY(:ids)")  # noqa: S608
_UPDATE = text(
    "UPDATE corpus.documents SET area = :area, subcategory = :subcategory,"
    " raw = raw || jsonb_build_object('area_label', CAST(:label AS jsonb)), updated_at = now()"
    " WHERE id = :id"
)
_STRATA = text(
    "SELECT id, COALESCE(proceeding_type, matter_type, 'unknown') AS proceeding,"
    " COALESCE(raw->>'seat', court, 'unknown') AS bench, headnote_only,"
    " (summary IS NOT NULL OR raw->>'head_note' IS NOT NULL) AS has_headnote"
    " FROM corpus.documents WHERE kind = 'judgment'"
)


def label_row(classifier: Classifier, row: Any) -> AreaLabel:
    cited = row.cited_laws if isinstance(row.cited_laws, list) else []
    return classifier.classify(
        row.full_text,
        headnote=row.summary or row.head_note,
        cited_laws=[c for c in cited if isinstance(c, str)],
        headnote_only=bool(row.headnote_only),
    )


def run(
    engine: Engine,
    taxonomy: Taxonomy,
    *,
    limit: int | None = None,
    batch_size: int = 500,
    dry_run: bool = False,
) -> tuple[Counter[str], Counter[str], int]:
    """Label the judgments in id order, one committed batch at a time. Returns the area counts,
    the reason counts and how many rows were written."""
    classifier = Classifier(taxonomy)
    areas: Counter[str] = Counter()
    reasons: Counter[str] = Counter()
    written = 0
    after = _ZERO
    seen = 0
    while limit is None or seen < limit:
        n = batch_size if limit is None else min(batch_size, limit - seen)
        with engine.begin() as conn:
            rows = list(conn.execute(_PAGE, {"after": after, "n": n}))
            if not rows:
                break
            updates = []
            for row in rows:
                label = label_row(classifier, row)
                areas[label.area] += 1
                reasons[label.reason] += 1
                record = label.as_raw(taxonomy.version)
                if (row.area, row.subcategory, row.area_label) != (
                    label.area,
                    label.subcategory,
                    record,
                ):
                    updates.append(
                        {
                            "id": row.id,
                            "area": label.area,
                            "subcategory": label.subcategory,
                            "label": json.dumps(record),
                        }
                    )
            if updates and not dry_run:
                conn.execute(_UPDATE, updates)
                written += len(updates)
        seen += len(rows)
        after = rows[-1].id
    return areas, reasons, written


def distribution(areas: Counter[str], reasons: Counter[str]) -> str:
    total = sum(areas.values())
    lines = ["| Area | Judgments | Share |", "|---|---:|---:|"]
    for area, count in sorted(areas.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f"| {area} | {count} | {count / total:.1%} |")
    lines += ["", f"- Judgments: {total}"]
    if total:
        lines.append(f"- Unclassified rate: {areas[UNCLASSIFIED] / total:.1%}")
    lines.append(
        "- Reasons: "
        + ", ".join(f"{r} {c}" for r, c in sorted(reasons.items(), key=lambda kv: -kv[1]))
    )
    return "\n".join(lines)


def _evidence_summary(label: AreaLabel) -> str:
    return "; ".join(f"{e.ref} [{e.where}] -> {e.area}" for e in label.evidence[:6])


def sample(
    conn: Connection,
    taxonomy: Taxonomy,
    n: int,
    out: Path,
    *,
    seed: int = 200,
    full_text_only: bool = False,
) -> int:
    """Write the hand-labelling sample. Only judgments a reviewer can read are eligible: a full
    judgment, or (unless ``full_text_only``) a head-note."""
    candidates = [
        Candidate(str(r.id), r.proceeding, r.bench)
        for r in conn.execute(_STRATA)
        if not r.headnote_only or (r.has_headnote and not full_text_only)
    ]
    picked = stratified(candidates, n, seed)
    rows = {str(r.id): r for r in conn.execute(_BY_IDS, {"ids": [uuid.UUID(c.id) for c in picked]})}
    classifier = Classifier(taxonomy)
    out_rows = []
    for c in picked:
        row = rows[c.id]
        label = label_row(classifier, row)
        out_rows.append(
            {
                "document_id": c.id,
                "collector_id": row.collector_id,
                "title": row.title,
                "case_number": row.case_number or "",
                "proceeding": c.proceeding,
                "bench": c.bench,
                "headnote_only": "yes" if row.headnote_only else "no",
                "official_url": row.official_url,
                "predicted_area": label.area,
                "predicted_subcategory": label.subcategory or "",
                "confidence": f"{label.confidence:.2f}",
                "reason": label.reason,
                "evidence": _evidence_summary(label),
            }
        )
    return write_sample(out_rows, out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Label judgments with an area of law from the statutes they cite "
        "(taxonomy v1, docs/engineering/case-taxonomy.md §5), or build and score the §6 review."
    )
    parser.add_argument("--limit", type=int, help="label at most N judgments (in id order)")
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true", help="classify without writing")
    parser.add_argument("--sample", type=int, metavar="N", help="write a stratified review sample")
    parser.add_argument("--out", type=Path, default=Path("area-review.csv"))
    parser.add_argument("--seed", type=int, default=200)
    parser.add_argument(
        "--full-text-only", action="store_true", help="sample full judgments only, no head-notes"
    )
    parser.add_argument("--score", type=Path, metavar="CSV", help="score a filled review sample")
    parser.add_argument("--taxonomy", type=Path, help="the taxonomy YAML (default: found)")
    args = parser.parse_args([a for a in (sys.argv[1:] if argv is None else argv) if a != "--"])
    if args.sample is not None and args.sample < 1:
        parser.error("--sample needs at least 1 judgment")

    taxonomy = load_taxonomy(args.taxonomy)
    if args.score:
        result = score(read_sample(args.score), list(taxonomy.areas))
        print(format_score(result))
        return 0

    engine = create_engine(DatabaseSettings().sqlalchemy_url)
    try:
        if args.sample is not None:
            with engine.connect() as conn:
                count = sample(
                    conn,
                    taxonomy,
                    args.sample,
                    args.out,
                    seed=args.seed,
                    full_text_only=args.full_text_only,
                )
            print(f"wrote {count} judgments to {args.out}; fill gold_area (and gold_subcategory)")
            return 0
        areas, reasons, written = run(
            engine, taxonomy, limit=args.limit, batch_size=args.batch_size, dry_run=args.dry_run
        )
    finally:
        engine.dispose()
    print(distribution(areas, reasons))
    print(f"- {'dry run: nothing written' if args.dry_run else f'rows updated: {written}'}")
    return 0
