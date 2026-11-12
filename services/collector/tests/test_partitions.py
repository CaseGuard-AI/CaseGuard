"""Partitions, selection files and the selection generator (#153)."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import pytest

from main import apply_partition, build_parser
from partitions import (
    PARTITIONS,
    SELECTIONS_DIR,
    IdSelection,
    get_partition,
    load_id_selection,
    load_title_selection,
)
from scrapers.base_scraper import Discovered
from storage.state_store import StateStore
from tests.test_shc_scraper import scraper  # noqa: F401  (fixture)
from tools import make_selection as ms

# ---- pk-code-seed -----------------------------------------------------------------------------

SEED = load_title_selection(SELECTIONS_DIR / "pk-code-seed.txt")


@pytest.mark.parametrize(
    "title",
    [
        # As the live index writes them (2026-11-10), double spaces included.
        "Pakistan Penal Code (PPC),1860 (Under Review) ",
        "Code of Criminal Procedure (CrPC), 1898 (Under Review) ",
        "Qanun-e-Shahadat Order, 1984 (QSO)",
        "Code of Civil Procedure (CPC) , 1908 (Under Review)",
        "Contract Act, 1872",
        "Specific Relief Act, 1877",
        "Limitation Act, 1908",
        "Constitution of the Islamic  Republic of Pakistan",
    ],
)
def test_the_seed_list_matches_the_seed_statutes(title: str) -> None:
    assert SEED.wants(Discovered(url="u", hints={"title": title}))


@pytest.mark.parametrize(
    "title",
    [
        "The Pakistan Army Act, 1952",
        "Income Tax Ordinance, 2001",
        # Matched by an unanchored "limitation act" in the first live run:
        "Fiscal Responsibility and Debt Limitation Act, 2005",
        "Professions Tax Limitation Act, 1941",
        "Government Contract Act, 1950",
    ],
)
def test_the_seed_list_leaves_other_statutes_out(title: str) -> None:
    assert not SEED.wants(Discovered(url="u", hints={"title": title}))


def test_a_title_selection_reports_patterns_that_never_matched(tmp_path: Path) -> None:
    path = tmp_path / "t.txt"
    path.write_text("# comment\npenal code\nno such statute\n", encoding="utf-8")
    sel = load_title_selection(path)
    sel.wants(Discovered(url="u", hints={"title": "Pakistan Penal Code"}))
    assert sel.missing() == ["no such statute"]
    assert len(sel.sha256) == 64


# ---- id selections on the SHC scraper ---------------------------------------------------------


def _selection_for(scraper, rows: list[str], tmp_path: Path) -> IdSelection:  # noqa: F811
    path = tmp_path / "shc-criminal.csv"
    lines = ["# source_snapshot: shc-meta@2026-11-10", "document_id,case_number,matter_type"]
    lines += [f"{IdSelection(path, '', source='shc_caselaw').id_of(r)},x,y" for r in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return load_id_selection(path, "shc_caselaw")


def test_a_selection_run_stores_only_the_listed_judgments(scraper, tmp_path):  # noqa: F811
    first = next(iter(scraper.discover()))
    selection = _selection_for(scraper, [first], tmp_path)
    assert selection.source_snapshot == "shc-meta@2026-11-10"
    scraper.settings.selection = selection
    scraper.run()
    assert scraper.stats.stored == 1
    assert selection.exhausted() and selection.missing() == []
    stored = [json.loads(ln) for ln in scraper.storage.path.read_text("utf-8").splitlines()]
    # The id the generator wrote is the id the crawl stores, so the loader can upgrade the row.
    assert [d["id"] for d in stored] == sorted(selection.ids)


def test_discovery_stops_once_everything_selected_was_found(scraper, tmp_path):  # noqa: F811
    first = next(iter(scraper.discover()))
    scraper.settings.selection = _selection_for(scraper, [first], tmp_path)
    scraper.run()
    # The fixture lists 3 judgments under each of 2 judges; the first row is enough.
    assert scraper.stats.discovered == 1


def test_selected_ids_never_found_are_reported(scraper, tmp_path):  # noqa: F811
    ghost = Discovered(url="https://caselaw.shc.gov.pk/caselaw/download-file.php?doc=gone")
    selection = _selection_for(scraper, [ghost], tmp_path)
    scraper.settings.selection = selection
    scraper.run()
    assert scraper.stats.stored == 0 and scraper.stats.not_selected == 6
    assert selection.missing() == sorted(selection.ids)


def test_a_selection_from_another_source_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "s.csv"
    path.write_text("document_id\npakistan_code-abc\n", encoding="utf-8")
    with pytest.raises(ValueError, match="another source"):
        load_id_selection(path, "shc_caselaw")


# ---- the CLI ----------------------------------------------------------------------------------


def _args(*argv: str) -> argparse.Namespace:
    return build_parser().parse_args(list(argv))


def test_shc_meta_is_all_scope_metadata_only_in_its_own_dir(tmp_settings) -> None:
    base = tmp_settings.output_dir
    args = _args("--partition", "shc-meta")
    apply_partition(tmp_settings, args)
    assert args.source == "shc_caselaw"
    assert tmp_settings.output_dir == base / "partitions" / "shc-meta"
    assert (tmp_settings.shc_scope, tmp_settings.download_pdfs) == ("all", False)
    assert tmp_settings.selection is None


def test_pk_code_seed_loads_its_title_list(tmp_settings) -> None:
    apply_partition(tmp_settings, _args("--partition", "pk-code-seed"))
    assert tmp_settings.selection.path.name == "pk-code-seed.txt"
    assert tmp_settings.download_pdfs is True


def test_a_partition_with_a_missing_selection_file_explains_how_to_make_it(
    tmp_settings, tmp_path
) -> None:
    args = _args("--partition", "shc-civil", "--selection", str(tmp_path / "nope.csv"))
    with pytest.raises(SystemExit, match="make_selection"):
        apply_partition(tmp_settings, args)


def test_a_partition_refuses_a_different_source(tmp_settings) -> None:
    with pytest.raises(SystemExit, match="drop --source"):
        apply_partition(tmp_settings, _args("--partition", "shc-meta", "--source", "pakistan_code"))


def test_an_unknown_partition_is_refused() -> None:
    with pytest.raises(SystemExit, match="Unknown partition"):
        get_partition("shc-everything")


def test_every_partition_named_in_the_registry_doc_exists() -> None:
    registry = (SELECTIONS_DIR.parent / "PARTITIONS.md").read_text(encoding="utf-8")
    for name in PARTITIONS:
        assert f"`{name}`" in registry


# ---- run metadata -----------------------------------------------------------------------------


def test_runs_record_the_partition_and_selection(tmp_path: Path) -> None:
    store = StateStore(tmp_path / "state.db")
    store.start_run(
        "r1",
        "shc_caselaw",
        partition="shc-civil",
        selection_file="selections/shc-civil.csv",
        selection_sha256="ab" * 32,
        source_snapshot="shc-meta@2026-11-10",
    )
    (run,) = store.runs()
    store.close()
    assert run["partition"] == "shc-civil"
    assert run["source_snapshot"] == "shc-meta@2026-11-10"


def test_an_older_state_db_gains_the_partition_columns(tmp_path: Path) -> None:
    path = tmp_path / "state.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE runs (run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL,"
        " ended_at TEXT, sources TEXT, summary TEXT)"
    )
    conn.execute("INSERT INTO runs VALUES ('old', 't', NULL, 'shc_caselaw', NULL)")
    conn.commit()
    conn.close()
    store = StateStore(path)
    store.start_run("new", "shc_caselaw", partition="shc-meta")
    runs = {r["run_id"]: r for r in store.runs()}
    store.close()
    assert runs["old"]["partition"] is None and runs["new"]["partition"] == "shc-meta"


# ---- the selection generator ------------------------------------------------------------------

CODES = ms.read_map(SELECTIONS_DIR / "matter_type_map.csv")


def shc(n: int, matter: str, year: int = 2020, **extra) -> dict:
    record = {
        "id": f"shc_caselaw-{n:024d}",
        "source": "shc_caselaw",
        "case_number": f"{n}/{year}",
        "matter_type": matter,
        "judgment_date": f"{year}-01-01",
        "document_file_url": f"https://caselaw.shc.gov.pk/caselaw/download-file.php?doc={n}",
        "raw": {"file_status": "not_downloaded"},
    }
    record.update(extra)
    return record


def test_the_map_covers_every_case_type_in_the_taxonomy() -> None:
    assert len(CODES) == 57
    assert CODES["Const. P"].branch == "either"
    assert CODES["Cr.Tran"].branch == "criminal" and CODES["Civil Tran"].branch == "civil"


def test_only_the_partitions_branch_with_a_file_is_eligible() -> None:
    records = [
        shc(1, "Cr.Bail"),
        shc(2, "Suit"),
        shc(3, "Const. P"),
        shc(4, "Unheard Of"),
        shc(5, "Cr.Bail", document_file_url=None, raw={"file_status": "missing_link"}),
        shc(1, "Cr.Bail"),  # the same judgment under a second judge
        {"id": "pakistan_code-x", "source": "pakistan_code"},
    ]
    pool, left_out = ms.candidates(records, CODES, "criminal")
    assert [c.document_id for c in pool] == [shc(1, "x")["id"]]
    assert left_out == {
        "civil, not criminal": 1,
        "branch depends on subject (constitutional petition)": 1,
        "unmapped case type": 1,
        "no judgment file linked": 1,
        "listed twice": 1,
        "not SHC": 1,
    }


def test_seats_are_proportional_and_add_up() -> None:
    seats = ms.allocate({("a", "1"): 70, ("b", "1"): 20, ("c", "1"): 10}, 10)
    assert seats == {("a", "1"): 7, ("b", "1"): 2, ("c", "1"): 1}
    assert sum(ms.allocate({("a", "1"): 5, ("b", "1"): 5, ("c", "1"): 5}, 7).values()) == 7
    assert ms.allocate({("a", "1"): 3}, 10) == {("a", "1"): 3}


def test_the_sample_is_stratified_and_deterministic(tmp_path: Path) -> None:
    records = [shc(i, "Cr.Bail", 2019 + i % 2) for i in range(80)]
    records += [shc(100 + i, "Cr.Rev", 2020) for i in range(20)]
    pool, _ = ms.candidates(records, CODES, "criminal")
    first = ms.stratified_sample(pool, 10, seed=42)
    assert first == ms.stratified_sample(pool, 10, seed=42)
    assert first != ms.stratified_sample(pool, 10, seed=7)
    by_stratum = {(c.matter_type, c.year) for c in first}
    assert by_stratum == {("Cr.Bail", "2019"), ("Cr.Bail", "2020"), ("Cr.Rev", "2020")}
    assert sum(c.matter_type == "Cr.Rev" for c in first) == 2


def test_a_generated_file_is_read_back_by_the_collector(tmp_path: Path) -> None:
    source = tmp_path / "shc-meta" / "documents"
    source.mkdir(parents=True)
    records = [shc(i, "Suit") for i in range(5)] + [shc(10, "Cr.Bail")]
    (source / "shc_caselaw.jsonl").write_text(
        "".join(json.dumps(r) + "\n" for r in records), encoding="utf-8"
    )
    out = tmp_path / "shc-civil.csv"
    argv = ["--from", str(tmp_path / "shc-meta"), "--partition", "shc-civil", "--n", "3"]
    argv += ["--source-snapshot", "shc-meta@2026-11-10", "--out", str(out)]
    assert ms.main(argv) == 0
    selection = load_id_selection(out, "shc_caselaw")
    assert len(selection.ids) == 3
    assert selection.source_snapshot == "shc-meta@2026-11-10"
    assert "civil: suit" in out.read_text(encoding="utf-8")


def test_proceeding_types_can_be_excluded() -> None:
    records = [
        shc(1, "Suit"),
        shc(2, "I.T.R.A"),
        shc(3, "Spl. Cus. Ref. A"),
        shc(4, "Election Appeal"),
    ]
    pool, left_out = ms.candidates(records, CODES, "civil", ["tax_reference"])
    assert [c.matter_type for c in pool] == ["Suit", "Election Appeal"]
    assert left_out == {"excluded: tax_reference": 2}


def test_an_unknown_proceeding_type_to_exclude_is_refused(tmp_path: Path) -> None:
    with pytest.raises(SystemExit):
        ms.main(["--from", str(tmp_path), "--partition", "shc-civil", "--exclude", "taxes"])
