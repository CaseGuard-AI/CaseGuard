"""Case taxonomy v1 (#164): the shared vocabulary stays consistent with itself and the collector.

``packages/contracts/taxonomy/case-taxonomy.v1.yaml`` names the values ``corpus.documents.area``,
``subcategory`` and ``proceeding_type`` may hold. The collector's SHC case-type map must only use
proceeding types it defines, on a compatible branch.
"""

from __future__ import annotations

import csv
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
TAXONOMY = REPO_ROOT / "packages" / "contracts" / "taxonomy" / "case-taxonomy.v1.yaml"
MATTER_TYPE_MAP = REPO_ROOT / "services" / "collector" / "selections" / "matter_type_map.csv"

SNAKE = re.compile(r"^[a-z][a-z0-9_]*$")
PROCEDURE = "procedure"


@pytest.fixture(scope="module")
def taxonomy() -> dict[str, Any]:
    data: dict[str, Any] = yaml.safe_load(TAXONOMY.read_text(encoding="utf-8"))
    return data


def test_version_and_branches(taxonomy: dict[str, Any]) -> None:
    assert taxonomy["version"] == "v1"
    assert taxonomy["branches"] == ["criminal", "civil"]


def test_areas_are_unique_snake_case_with_a_branch(taxonomy: dict[str, Any]) -> None:
    ids = [area["id"] for area in taxonomy["areas"]]
    assert len(ids) == len(set(ids))
    for area in taxonomy["areas"]:
        assert SNAKE.match(area["id"]), area["id"]
        if area["id"] == "unclassified":
            assert area["branch"] is None
        else:
            assert area["branch"] in taxonomy["branches"], area["id"]
        subs = area["subcategories"]
        assert len(subs) == len(set(subs)), area["id"]
        assert all(SNAKE.match(sub) for sub in subs), area["id"]
    # Doc §3.1: 9 criminal and 11 civil areas, plus unclassified.
    branches = [area["branch"] for area in taxonomy["areas"]]
    assert (branches.count("criminal"), branches.count("civil")) == (9, 11)


def test_proceeding_types_are_unique_with_a_branch(taxonomy: dict[str, Any]) -> None:
    ids = [p["id"] for p in taxonomy["proceeding_types"]]
    assert len(ids) == len(set(ids)) == 19
    for proceeding in taxonomy["proceeding_types"]:
        assert SNAKE.match(proceeding["id"]), proceeding["id"]
        assert proceeding["branch"] in [*taxonomy["branches"], "either"], proceeding["id"]
        assert all(SNAKE.match(sub) for sub in proceeding["subtypes"]), proceeding["id"]


def test_statute_rules_point_at_known_areas(taxonomy: dict[str, Any]) -> None:
    areas = {area["id"]: area for area in taxonomy["areas"]}
    for rule in taxonomy["statute_rules"]:
        if rule["area"] == PROCEDURE:
            assert "subcategory" not in rule, rule
            continue
        assert rule["area"] in areas, rule
        if "subcategory" in rule:
            assert rule["subcategory"] in areas[rule["area"]]["subcategories"], rule


def test_matter_type_map_uses_taxonomy_proceeding_types(taxonomy: dict[str, Any]) -> None:
    branches = {p["id"]: p["branch"] for p in taxonomy["proceeding_types"]}
    with MATTER_TYPE_MAP.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    assert rows
    for row in rows:
        proceeding, branch = row["proceeding_type"], row["branch"]
        assert proceeding in branches, row
        # A code's branch must match its proceeding type, unless the type is `either`, where each
        # code decides (e.g. Cr.Tran vs Civil Tran).
        if branches[proceeding] == "either":
            assert branch in ["criminal", "civil", "either"], row
        else:
            assert branch == branches[proceeding], row
