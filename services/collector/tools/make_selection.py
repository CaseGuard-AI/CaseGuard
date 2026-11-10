#!/usr/bin/env python3
"""Write a stratified selection file for shc-criminal / shc-civil from an shc-meta crawl (#153).

    python tools/make_selection.py --from data/partitions/shc-meta \\
        --partition shc-criminal --n 3000 --source-snapshot shc-meta@2026-11-10

* Each record's SHC case type (``matter_type``) is looked up in ``selections/matter_type_map.csv``.
  Only codes whose branch is the partition's (criminal or civil) are eligible. ``either``
  (constitutional petitions, whose branch depends on the subject) and codes missing from the map
  are left out and counted, never guessed (docs/engineering/case-taxonomy.md §4).
* Records with no judgment file to download are left out too.
* The sample is stratified by case type x year, with seats allocated in proportion to each
  stratum's size (largest remainder), and is the same for the same input, map, n and seed.

The output CSV starts with ``#`` comment lines (source snapshot, seed, counts), which the
collector reads back and records in the run metadata.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import random
import sys
from collections import Counter, defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from partitions import SELECTIONS_DIR  # noqa: E402

BRANCH_OF_PARTITION = {"shc-criminal": "criminal", "shc-civil": "civil"}
FIELDS = ["document_id", "case_number", "matter_type", "year", "reason"]


@dataclass(frozen=True)
class Code:
    proceeding_type: str
    branch: str
    confirmed: bool


@dataclass(frozen=True)
class Candidate:
    document_id: str
    case_number: str
    matter_type: str
    year: str


def normalise_code(value: str | None) -> str:
    return " ".join((value or "").split())


def read_map(path: Path) -> dict[str, Code]:
    with path.open(encoding="utf-8", newline="") as fh:
        rows = list(csv.DictReader(fh))
    codes: dict[str, Code] = {}
    for row in rows:
        branch = row["branch"].strip()
        if branch not in {"criminal", "civil", "either"}:
            raise ValueError(f"{path}: unknown branch {branch!r} for {row['matter_type']!r}")
        codes[normalise_code(row["matter_type"])] = Code(
            row["proceeding_type"].strip(), branch, row.get("confirmed", "yes").strip() == "yes"
        )
    return codes


def input_files(path: Path) -> list[Path]:
    """A crawl or partition dir (its documents/shc_caselaw.jsonl), or JSONL / JSONL.gz files."""
    if path.is_dir():
        found = path / "documents" / "shc_caselaw.jsonl"
        if not found.exists():
            found = path / "shc_caselaw.jsonl"
        if not found.exists():
            raise FileNotFoundError(f"no shc_caselaw.jsonl under {path}")
        return [found]
    return [path]


def read_records(paths: Iterable[Path]) -> Iterator[dict]:
    for path in paths:
        if path.suffix == ".gz":
            stream: io.TextIOBase = gzip.open(path, "rt", encoding="utf-8")  # type: ignore[assignment]
        else:
            stream = path.open(encoding="utf-8")
        with stream:
            for line in stream:
                if line.strip():
                    yield json.loads(line)


def year_of(record: dict) -> str:
    for value in (record.get("judgment_date"), record.get("date")):
        if value and str(value)[:4].isdigit():
            return str(value)[:4]
    number = record.get("case_number") or ""
    tail = number.rsplit("/", 1)[-1]
    return tail if tail.isdigit() and len(tail) == 4 else "unknown"


def candidates(
    records: Iterable[dict],
    codes: dict[str, Code],
    branch: str,
    exclude: Iterable[str] = (),
) -> tuple[list[Candidate], Counter[str]]:
    """Eligible records for ``branch`` plus a count of why the others were left out.

    ``exclude`` names proceeding types to leave out, e.g. the tax references, which are civil
    but outside the M1 civil seed statutes (case-taxonomy.md §9, decision 3)."""
    excluded = set(exclude)
    out: dict[str, Candidate] = {}
    left_out: Counter[str] = Counter()
    for record in records:
        if record.get("source") != "shc_caselaw":
            left_out["not SHC"] += 1
            continue
        code = codes.get(normalise_code(record.get("matter_type")))
        if code is None:
            left_out["unmapped case type"] += 1
            continue
        if code.branch == "either":
            left_out["branch depends on subject (constitutional petition)"] += 1
            continue
        if code.branch != branch:
            left_out[f"{code.branch}, not {branch}"] += 1
            continue
        if code.proceeding_type in excluded:
            left_out[f"excluded: {code.proceeding_type}"] += 1
            continue
        raw = record.get("raw") or {}
        if raw.get("file_status") == "missing_link" or not record.get("document_file_url"):
            left_out["no judgment file linked"] += 1
            continue
        doc_id = record["id"]
        if doc_id in out:
            left_out["listed twice"] += 1
            continue
        out[doc_id] = Candidate(
            doc_id,
            record.get("case_number") or "",
            normalise_code(record.get("matter_type")),
            year_of(record),
        )
    return sorted(out.values(), key=lambda c: c.document_id), left_out


def allocate(sizes: dict[tuple[str, str], int], n: int) -> dict[tuple[str, str], int]:
    """Seats per stratum in proportion to its size (largest remainder, ties by key)."""
    total = sum(sizes.values())
    if n >= total:
        return dict(sizes)
    quotas = {k: n * v / total for k, v in sizes.items()}
    seats = {k: int(q) for k, q in quotas.items()}
    spare = n - sum(seats.values())
    for key in sorted(quotas, key=lambda k: (-(quotas[k] - seats[k]), k))[:spare]:
        seats[key] += 1
    return seats


def stratified_sample(pool: list[Candidate], n: int, seed: int) -> list[Candidate]:
    strata: dict[tuple[str, str], list[Candidate]] = defaultdict(list)
    for cand in pool:
        strata[(cand.matter_type, cand.year)].append(cand)
    seats = allocate({k: len(v) for k, v in strata.items()}, n)
    rng = random.Random(seed)
    chosen: list[Candidate] = []
    for key in sorted(strata):
        members = sorted(strata[key], key=lambda c: c.document_id)
        chosen.extend(rng.sample(members, seats[key]))
    return sorted(chosen, key=lambda c: (c.matter_type, c.year, c.document_id))


def write_selection(
    out: Path,
    chosen: list[Candidate],
    codes: dict[str, Code],
    *,
    header: dict[str, str],
) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="") as fh:
        for key, value in header.items():
            fh.write(f"# {key}: {value}\n")
        writer = csv.DictWriter(fh, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        for cand in chosen:
            code = codes[cand.matter_type]
            reason = f"{code.branch}: {code.proceeding_type}"
            if not code.confirmed:
                reason += " (case type reading unconfirmed)"
            writer.writerow(
                {
                    "document_id": cand.document_id,
                    "case_number": cand.case_number,
                    "matter_type": cand.matter_type,
                    "year": cand.year,
                    "reason": reason,
                }
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", type=Path, required=True)
    parser.add_argument("--partition", required=True, choices=sorted(BRANCH_OF_PARTITION))
    parser.add_argument("--n", type=int, default=3000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--map", type=Path, default=SELECTIONS_DIR / "matter_type_map.csv")
    parser.add_argument(
        "--source-snapshot",
        default=None,
        help="the shc-meta snapshot read, e.g. shc-meta@2026-11-10 (recorded in the file)",
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="PROCEEDING_TYPE",
        help="leave out a proceeding type (repeatable), e.g. --exclude tax_reference",
    )
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args(argv)

    codes = read_map(args.map)
    known = {c.proceeding_type for c in codes.values()}
    unknown = sorted(set(args.exclude) - known)
    if unknown:
        parser.error(
            f"unknown proceeding type(s): {', '.join(unknown)}. Known: {', '.join(sorted(known))}"
        )
    branch = BRANCH_OF_PARTITION[args.partition]
    pool, left_out = candidates(read_records(input_files(args.source)), codes, branch, args.exclude)
    chosen = stratified_sample(pool, args.n, args.seed)
    out = args.out or SELECTIONS_DIR / f"{args.partition}.csv"
    map_sha = hashlib.sha256(args.map.read_bytes()).hexdigest()
    write_selection(
        out,
        chosen,
        codes,
        header={
            "partition": args.partition,
            "source_snapshot": args.source_snapshot or "unpublished local crawl",
            "map": f"{args.map.name} sha256={map_sha[:16]}",
            "seed": str(args.seed),
            "excluded": ", ".join(sorted(args.exclude)) or "none",
            "selected": f"{len(chosen)} of {len(pool)} eligible",
        },
    )
    print(f"wrote {out}: {len(chosen)} of {len(pool)} eligible {branch} judgments")
    by_type = Counter(c.matter_type for c in chosen)
    for code, count in by_type.most_common():
        print(f"  {count:>6}  {code}")
    if left_out:
        print("left out:")
        for reason, count in left_out.most_common():
            print(f"  {count:>6}  {reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
