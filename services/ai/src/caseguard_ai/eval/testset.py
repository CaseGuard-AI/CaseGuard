"""Check and freeze the evaluation test set (#22, PRD §11, FR-RES-9).

    uv run python -m caseguard_ai.eval.testset check [--corpus]
    uv run python -m caseguard_ai.eval.testset freeze
    pnpm eval:testset -- check --corpus

The test set is ``eval/testset/dev.jsonl`` (60 questions) and ``heldout.jsonl`` (40). Each row is
an extractive question whose ground truth is a statute section, so it can be checked mechanically
(PRD §11): ``gold`` names the act, the section and its heading, and ``reference_answer`` quotes the
section. Unanswerable rows (about 10%) have no gold and list ``absent_terms``, phrases that occur
nowhere in the corpus.

``check`` validates the rows and the PRD §11 balance (half civil, half criminal, about 10%
unanswerable, no question in both splits) and, if ``FROZEN.sha256`` exists, that the held-out file
still matches it. ``--corpus`` also resolves every gold section against the loaded corpus, and
confirms that no ``absent_terms`` phrase occurs in it.

``freeze`` writes ``FROZEN.sha256`` for ``heldout.jsonl``. It must be run, and the commit tagged
``eval-heldout-v1``, before any tuning; after that the held-out file never changes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[5] / "eval" / "testset"
SPLITS = {"dev": 60, "heldout": 40}
FROZEN = "FROZEN.sha256"

# Gold act code → the start of its corpus.documents title.
ACTS = {
    "PPC": "Pakistan Penal Code",
    "CrPC": "Code of Criminal Procedure",
    "CPC": "Code of Civil Procedure",
    "CA": "Contract Act",
    "SRA": "Specific Relief Act",
    "LA": "Limitation Act",
    "QSO": "Qanun-e-Shahadat",
    "FRDLA": "Fiscal Responsibility and Debt Limitation Act",
    "PTLA": "Professions Tax Limitation Act",
}
DOMAINS = ("civil", "criminal")
UNANSWERABLE_SHARE = (0.08, 0.12)
# PRD §11 minimums. Temporal questions need the curated section versions (§10, M2), which do not
# exist yet, so both are reported, not enforced.
MIN_AS_OF = 8
MIN_URDU = 15
# A reference answer counts as found in its act when this share of its word 5-grams is there:
# the corpus text has footnote markers and OCR slips ("dishonest1y") the quotes leave out.
MIN_COVERAGE = 0.6

REQUIRED: dict[str, type | tuple[type, ...]] = {
    "id": str,
    "question": str,
    "domain": str,
    "answerable": bool,
    "gold": list,
    "reference_answer": (str, type(None)),
    "as_of": (str, type(None)),
}
OPTIONAL: dict[str, type | tuple[type, ...]] = {
    "urdu": str,
    "roman_urdu": str,
    "needs_native_review": bool,
    "absent_terms": list,
}


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def load(root: Path = ROOT) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    for split in SPLITS:
        lines = (root / f"{split}.jsonl").read_text(encoding="utf-8").splitlines()
        out[split] = [json.loads(line) for line in lines if line.strip()]
    return out


def normalise(text: str) -> str:
    """Lower-case words only: drops footnote markers (``2[``, ``* * *``), dashes and quotes."""
    text = re.sub(r"\d*\[|\]", " ", text.lower())
    return " ".join(re.findall(r"[a-z0-9]+", text))


def validate_row(split: str, row: dict[str, Any]) -> list[str]:
    rid = row.get("id", "?")
    errs = [f"{rid}: missing {k}" for k in REQUIRED if k not in row]
    errs += [f"{rid}: unknown field {k}" for k in row if k not in REQUIRED and k not in OPTIONAL]
    for k, t in {**REQUIRED, **OPTIONAL}.items():
        if k in row and not isinstance(row[k], t):
            errs.append(f"{rid}: {k} has the wrong type")
    if errs:
        return errs
    if not re.fullmatch(rf"{split}-\d{{3}}", rid):
        errs.append(f"{rid}: id must look like {split}-NNN")
    if row["domain"] not in DOMAINS:
        errs.append(f"{rid}: domain must be one of {DOMAINS}")
    if not row["question"].strip():
        errs.append(f"{rid}: empty question")
    if row["answerable"]:
        if not row["gold"] or not row["reference_answer"]:
            errs.append(f"{rid}: an answerable question needs gold and a reference_answer")
        for g in row["gold"]:
            if set(g) != {"act", "section", "heading"} or g.get("act") not in ACTS:
                errs.append(
                    f"{rid}: gold must be {{act, section, heading}} with act in {list(ACTS)}"
                )
        if "absent_terms" in row:
            errs.append(f"{rid}: absent_terms is only for unanswerable questions")
    else:
        if row["gold"] or row["reference_answer"] is not None:
            errs.append(f"{rid}: an unanswerable question has no gold and no reference_answer")
        if not row.get("absent_terms"):
            errs.append(f"{rid}: an unanswerable question lists its absent_terms")
    if ("urdu" in row) != ("roman_urdu" in row):
        errs.append(f"{rid}: give both urdu and roman_urdu, or neither")
    if "urdu" in row and row.get("needs_native_review") is not True:
        errs.append(f"{rid}: machine-written Urdu stays needs_native_review until reviewed (#105)")
    return errs


def check(sets: dict[str, list[dict[str, Any]]], root: Path = ROOT) -> Report:
    r = Report()
    for split, rows in sets.items():
        for row in rows:
            r.errors += validate_row(split, row)
        if len(rows) != SPLITS[split]:
            r.errors.append(f"{split}: {len(rows)} questions, expected {SPLITS[split]}")
        ids = Counter(row.get("id") for row in rows)
        r.errors += [f"{split}: duplicate id {i}" for i, n in ids.items() if n > 1]
        domains = Counter(row.get("domain") for row in rows)
        if domains["civil"] != domains["criminal"]:
            r.errors.append(f"{split}: {dict(domains)}, expected half civil and half criminal")
        share = sum(not row.get("answerable", True) for row in rows) / max(len(rows), 1)
        low, high = UNANSWERABLE_SHARE
        if not low <= share <= high:
            r.errors.append(f"{split}: {share:.0%} unanswerable, expected about 10%")

    seen: dict[str, str] = {}
    for rows in sets.values():
        for row in rows:
            key = normalise(row.get("question", ""))
            if key in seen:
                r.errors.append(f"{row.get('id')}: same question as {seen[key]}")
            seen.setdefault(key, row.get("id", "?"))

    every = [row for rows in sets.values() for row in rows]
    as_of = sum(row.get("as_of") is not None for row in every)
    urdu = sum("urdu" in row for row in every)
    if as_of < MIN_AS_OF:
        r.warnings.append(
            f"{as_of} as-of questions, PRD §11 asks for {MIN_AS_OF}: add them once the curated "
            "section versions exist (§10, M2)"
        )
    if urdu < MIN_URDU:
        r.warnings.append(f"{urdu} questions with Urdu phrasings, PRD §11 asks for {MIN_URDU}")
    r.notes.append(
        f"{len(every)} questions; {as_of} as-of; {urdu} with Urdu and Roman-Urdu phrasings"
    )

    frozen = root / FROZEN
    if frozen.exists():
        want = frozen.read_text(encoding="utf-8").split()[0]
        if sha256(root / "heldout.jsonl") != want:
            r.errors.append(
                "heldout.jsonl no longer matches FROZEN.sha256: the held-out set is frozen"
            )
        else:
            r.notes.append("heldout.jsonl matches FROZEN.sha256")
    else:
        r.warnings.append("held-out set not frozen yet: run `freeze` before any tuning")
    return r


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze(root: Path = ROOT) -> str:
    digest = sha256(root / "heldout.jsonl")
    (root / FROZEN).write_text(f"{digest}  heldout.jsonl\n", encoding="utf-8", newline="\n")
    return digest


# --- against the loaded corpus ---------------------------------------------------------------


def heading_pattern(section: str, heading: str) -> re.Pattern[str]:
    """``302. Punishment of …``: the number, then the heading, allowing footnote debris between.

    No boundary before the number: the corpus glues footnote numbers on (``1500.`` for s. 500).
    """
    number = re.escape(section).replace(r"\-", "-?")
    words = r"\W+".join(re.escape(w) for w in re.findall(r"\w+", heading))
    return re.compile(rf"{number}\s*\.\W{{0,6}}{words}", re.IGNORECASE)


def shingles(text: str, n: int = 5) -> set[str]:
    words = normalise(text).split()
    return {" ".join(words[i : i + n]) for i in range(max(len(words) - n + 1, 1))}


def coverage(reference: str, act_text_norm: str) -> float:
    grams = shingles(reference)
    return sum(g in act_text_norm for g in grams) / len(grams)


@dataclass
class Act:
    text: str  # every chunk, in order
    norm: str
    section_ids: dict[str, list[str]]  # section_id → texts of its chunks


def check_corpus(
    sets: dict[str, list[dict[str, Any]]], acts: dict[str, Act], hits: dict[str, int]
) -> Report:
    """``acts``: the loaded chunks of each gold act; ``hits``: corpus matches per absent term."""
    r = Report()
    for rows in sets.values():
        for row in rows:
            rid = row["id"]
            for g in row["gold"]:
                act = acts.get(g["act"])
                if act is None:
                    r.errors.append(f"{rid}: {g['act']} is not in the corpus")
                    continue
                if not heading_pattern(g["section"], g["heading"]).search(act.text):
                    r.errors.append(
                        f"{rid}: {g['act']} s. {g['section']} ({g['heading']}) not found"
                    )
                    continue
                cov = coverage(row["reference_answer"], act.norm)
                if cov < MIN_COVERAGE:
                    r.errors.append(f"{rid}: reference answer only {cov:.0%} found in {g['act']}")
                # Retrieval cites by section_id, so a section the chunker labelled wrongly or not
                # at all is a corpus defect the evaluation will show up; report it, don't fail.
                tagged = act.section_ids.get(g["section"].replace("-", "")) or act.section_ids.get(
                    g["section"]
                )
                if not tagged or not any(
                    heading_pattern(g["section"], g["heading"]).search(t) for t in tagged
                ):
                    r.warnings.append(
                        f"{rid}: no chunk of {g['act']} has section_id {g['section']} for this section"
                    )
            for term in row.get("absent_terms", []):
                if hits.get(term, 0):
                    r.errors.append(f"{rid}: '{term}' occurs {hits[term]} times in the corpus")
    return r


def load_corpus(sets: dict[str, list[dict[str, Any]]]) -> tuple[dict[str, Act], dict[str, int]]:
    from sqlalchemy import create_engine, text

    from caseguard_ai.config import DatabaseSettings

    every = [row for rows in sets.values() for row in rows]
    codes = sorted({g["act"] for row in every for g in row["gold"]})
    terms = sorted({t for row in every for t in row.get("absent_terms", [])})
    engine = create_engine(DatabaseSettings().sqlalchemy_url)
    acts: dict[str, Act] = {}
    hits: dict[str, int] = {}
    with engine.connect() as conn:
        for code in codes:
            rows = conn.execute(
                text(
                    "SELECT c.section_id, c.text FROM corpus.chunks c"
                    " JOIN corpus.documents d ON d.id = c.document_id"
                    " WHERE d.title LIKE :title AND d.kind IN ('statute', 'other')"
                    " ORDER BY d.id, c.ordinal"
                ),
                {"title": ACTS[code] + "%"},
            ).all()
            if not rows:
                continue
            ids: dict[str, list[str]] = {}
            for sid, body in rows:
                if sid:
                    ids.setdefault(sid, []).append(body)
            whole = "\n".join(body for _, body in rows)
            acts[code] = Act(whole, normalise(whole), ids)
        for term in terms:
            hits[term] = conn.execute(
                text("SELECT count(*) FROM corpus.chunks WHERE text ILIKE :p"),
                {"p": "%" + term.replace("%", r"\%").replace("_", r"\_") + "%"},
            ).scalar_one()
    engine.dispose()
    return acts, hits


def show(r: Report) -> None:
    for e in r.errors:
        print(f"error: {e}")
    for w in r.warnings:
        print(f"warning: {w}")
    for n in r.notes:
        print(n)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    sub = parser.add_subparsers(dest="command", required=True)
    c = sub.add_parser("check", help="validate the test set")
    c.add_argument("--corpus", action="store_true", help="also resolve gold sections in the corpus")
    sub.add_parser("freeze", help="write FROZEN.sha256 for heldout.jsonl")
    args = parser.parse_args(argv)

    sets = load()
    if args.command == "freeze":
        report = check(sets)
        if not report.ok:
            show(report)
            print("not frozen: fix the errors first")
            return 1
        print(f"froze heldout.jsonl: {freeze()}")
        print("now commit it and tag the commit eval-heldout-v1")
        return 0

    report = check(sets)
    if args.corpus:
        corpus = check_corpus(sets, *load_corpus(sets))
        report.errors += corpus.errors
        report.warnings += corpus.warnings
    show(report)
    print("ok" if report.ok else f"{len(report.errors)} error(s)")
    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
