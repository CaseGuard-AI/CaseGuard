"""The procedural linter (#214, FR-LINT-1, FR-LINT-2, FR-LINT-3, ADR-0012).

Pure: no database and no model. Each complete fixture in tests/data/lint is linted clean, and a
seeded defect per rule produces exactly that rule's finding. Every 200 response is checked
against packages/contracts/openapi/ai.v1.yaml.
"""

from __future__ import annotations

import copy
import hashlib
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from caseguard_ai.linter.engine import lint, utf16_offset
from caseguard_ai.linter.rules import RULES_DIR, RulesetError, load_rulesets, parse_ruleset
from tests.conftest import TOKEN

SERVICE_DIR = Path(__file__).resolve().parents[1]
CONTRACT = SERVICE_DIR.parents[1] / "packages" / "contracts" / "openapi" / "ai.v1.yaml"
DATA = Path(__file__).resolve().parent / "data" / "lint"

_DOC = yaml.safe_load(CONTRACT.read_text(encoding="utf-8"))


def conforms(name: str, body: Any) -> None:
    schema = {"$ref": f"#/components/schemas/{name}", "components": _DOC["components"]}
    validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
    errors = sorted(validator.iter_errors(body), key=str)
    assert not errors, [e.message for e in errors]


def fixture(name: str) -> str:
    # newline="" keeps the file's bytes as they are, so offsets are stable on every platform.
    with open(DATA / f"{name}.txt", encoding="utf-8", newline="") as f:
        return f.read()


BAIL_497 = "bail_497_complete"
BAIL_498 = "bail_498_complete"
PLAINT = "plaint_complete"

DOC_TYPE = {BAIL_497: "bail_application", BAIL_498: "bail_application", PLAINT: "plaint"}


# ── seeded defects ─────────────────────────────────────────────────────────────────────────

Mutation = Callable[[str], str]


def drop(*olds: str, new: str = "") -> Mutation:
    """Replace every occurrence of each string; fail if one is absent, so a fixture edit can't
    make a test pass vacuously."""

    def mutate(text: str) -> str:
        for old in olds:
            assert old in text, old
            text = text.replace(old, new)
        return text

    return mutate


def move(start: str, end: str, before: str) -> Mutation:
    """Cut ``text[start:end)`` and paste it in front of ``before``."""

    def mutate(text: str) -> str:
        i = text.index(start)
        j = text.index(end, i)
        block, rest = text[i:j], text[:i] + text[j:]
        k = rest.index(before)
        return rest[:k] + block + rest[k:]

    return mutate


SEEDED: dict[str, tuple[str, Mutation]] = {
    # bail application (s.497 / s.498 CrPC)
    "bail.court_heading": (BAIL_497, drop("IN THE COURT OF SESSIONS JUDGE, KARACHI SOUTH\n")),
    "bail.title": (BAIL_497, drop(" UNDER SECTION 497 Cr.P.C.")),
    "bail.fir_number": (BAIL_497, drop("FIR No. 245/2026", new="FIR")),
    "bail.fir_date": (BAIL_497, drop(" dated 03.08.2026")),
    "bail.police_station": (BAIL_497, drop("Police Station ")),
    "bail.offence_sections": (BAIL_497, drop("Under Sections 380 and 457 PPC\n")),
    "bail.accused_particulars": (
        BAIL_497,
        drop(
            "son of Abdul Rehman, aged about 32 years,\nresident of House No. 14, Street 7, Lyari, Karachi\n"
        ),
    ),
    "bail.custody_status": (
        BAIL_497,
        drop(
            "(presently confined in Central Prison, Karachi) ",
            " and is in judicial custody since then",
        ),
    ),
    "bail.arrest_date": (BAIL_497, drop(" on 05.08.2026")),
    "bail.grounds": (BAIL_497, drop("GROUNDS\n")),
    "bail.apprehension_of_arrest": (
        BAIL_498,
        drop("apprehends his arrest at the hands of", new="is being harassed by"),
    ),
    "bail.earlier_application": (
        BAIL_497,
        drop(
            "3. That no other bail application on behalf of the applicant has been filed"
            " before this Court or any other Court.\n\n"
        ),
    ),
    "bail.prayer": (
        BAIL_497,
        drop(
            "PRAYER\n\nIt is, therefore, most respectfully prayed that the applicant may kindly be"
            " admitted to post-arrest bail in the above case on such terms as this Court deems"
            " fit.\n\n"
        ),
    ),
    "bail.verification": (BAIL_497, drop("AFFIDAVIT\n\n")),
    "bail.advocate_signature": (
        BAIL_497,
        drop("Advocate for the Applicant\n(Ali Raza, Advocate High Court)\n"),
    ),
    "bail.prayer_after_grounds": (BAIL_497, move("PRAYER\n", "Applicant\nThrough", "GROUNDS\n")),
    # plaint (Order VII CPC)
    "plaint.court_name": (PLAINT, drop("IN THE COURT OF SENIOR CIVIL JUDGE, KARACHI EAST\n")),
    "plaint.plaintiff_particulars": (
        PLAINT,
        drop(
            "daughter of Muhammad Iqbal, adult, Muslim, housewife,\nresident of House No. B-22,"
            " Block 13, Gulshan-e-Iqbal, Karachi "
        ),
    ),
    "plaint.defendant_particulars": (
        PLAINT,
        drop(
            "son of Abdul Majeed, adult, Muslim, businessman,\nresident of Flat No. 5, Al-Noor"
            " Apartments, Gulistan-e-Jauhar, Karachi "
        ),
    ),
    "plaint.cause_of_action": (PLAINT, drop("cause of action", new="dispute")),
    "plaint.cause_of_action_date": (
        PLAINT,
        drop(
            "first arose on 15.01.2026 when the defendant unlawfully occupied the suit property,"
            " and again on 10.02.2026 when he refused to vacate it, and it",
            new="arose against the defendant and it",
        ),
    ),
    "plaint.jurisdiction": (
        PLAINT,
        drop(
            "5. That the suit property is situated within the territorial jurisdiction of this"
            " Court and the defendant resides in Karachi, so this Court has jurisdiction to try"
            " this suit.\n\n"
        ),
    ),
    "plaint.property_description": (
        PLAINT,
        drop(
            ", measuring 240 square yards, bounded on the north by House No. B-21, on the south"
            " by a 30-feet road, on the east by House No. B-23 and on the west by a lane"
        ),
    ),
    "plaint.relief": (
        PLAINT,
        lambda t: t[: t.index("PRAYER\n")] + t[t.index("Plaintiff\n\nThrough") :],
    ),
    "plaint.valuation": (
        PLAINT,
        drop(
            " for the purposes of jurisdiction, and court fee of Rs. 15,000 has been paid on the"
            " plaint as required by law"
        ),
    ),
    "plaint.signature": (PLAINT, drop("Advocate for the Plaintiff\n")),
    "plaint.verification": (PLAINT, lambda t: t[: t.index("VERIFICATION\n")]),
    "plaint.verification_paragraphs": (
        PLAINT,
        drop(
            "the contents of paragraphs 1 to 6 are true to my own knowledge and the rest are"
            " believed to be true on information received",
            new="the contents of the plaint are true",
        ),
    ),
    "plaint.relief_after_cause_of_action": (
        PLAINT,
        move("PRAYER\n", "Plaintiff\n\nThrough", "1. That the plaintiff is the lawful owner"),
    ),
    "plaint.verification_last": (PLAINT, move("VERIFICATION\n", "\nPlaintiff\n", "PRAYER\n")),
}


def all_rule_ids() -> list[str]:
    return [r.id for rs in load_rulesets().values() for r in rs.rules]


# ── FR-LINT-1: complete documents and seeded defects ───────────────────────────────────────


@pytest.mark.parametrize("name", [BAIL_497, BAIL_498, PLAINT])
def test_complete_documents_have_no_findings(name: str) -> None:
    result = lint(DOC_TYPE[name], fixture(name))
    assert [f.rule_id for f in result.findings] == []
    assert not [f for f in result.findings if f.severity == "error"]


def test_every_rule_has_a_seeded_defect() -> None:
    assert sorted(SEEDED) == sorted(all_rule_ids())


@pytest.mark.parametrize("rule_id", sorted(SEEDED))
def test_seeded_defect_produces_exactly_that_finding(rule_id: str) -> None:
    name, mutate = SEEDED[rule_id]
    text = mutate(fixture(name))
    assert text != fixture(name)
    findings = lint(DOC_TYPE[name], text).findings
    assert [f.rule_id for f in findings] == [rule_id]


def test_finding_carries_the_rules_kind_severity_and_source() -> None:
    name, mutate = SEEDED["bail.grounds"]
    (finding,) = lint("bail_application", mutate(fixture(name))).findings
    rule = next(r for r in load_rulesets()["bail_application"].rules if r.id == "bail.grounds")
    assert (finding.kind, finding.severity, finding.source) == (
        rule.kind,
        rule.severity,
        rule.source,
    )
    assert finding.source is not None and finding.source.provision == "s.497(2) CrPC"
    assert finding.message.startswith("Could not find")
    assert finding.span is None


def test_missing_particular_next_to_its_anchor_points_at_the_anchor() -> None:
    name, mutate = SEEDED["bail.fir_number"]
    text = mutate(fixture(name))
    (finding,) = lint("bail_application", text).findings
    assert finding.span is not None
    start, end = finding.span
    assert text[start:end] == "FIR"


def test_structure_finding_points_at_the_misplaced_section() -> None:
    name, mutate = SEEDED["bail.prayer_after_grounds"]
    text = mutate(fixture(name))
    (finding,) = lint("bail_application", text).findings
    assert finding.kind == "structure" and finding.span is not None
    assert text[finding.span[0] : finding.span[1]] == "PRAYER"


def test_s498_rules_switch_on_the_title() -> None:
    # A s.497 application isn't asked for an apprehension of arrest, and a s.498 one isn't
    # asked for custody or an arrest date.
    ids_497 = {r.id for r in load_rulesets()["bail_application"].rules}
    assert "bail.apprehension_of_arrest" in ids_497
    bare = "IN THE COURT OF SESSIONS JUDGE\nAPPLICATION UNDER SECTION 498 Cr.P.C.\n"
    found = {f.rule_id for f in lint("bail_application", bare).findings}
    assert "bail.apprehension_of_arrest" in found
    assert not found & {"bail.custody_status", "bail.arrest_date"}
    bare_497 = bare.replace("498", "497")
    found = {f.rule_id for f in lint("bail_application", bare_497).findings}
    assert "bail.apprehension_of_arrest" not in found
    assert {"bail.custody_status", "bail.arrest_date"} <= found


def test_findings_in_document_order_then_unspanned_in_rule_order() -> None:
    text = "FIR\nsomething\nFIR No. 12/2026\n"
    findings = lint("bail_application", text).findings
    spanned = [f.span for f in findings if f.span is not None]
    assert spanned == sorted(spanned)
    first_unspanned = next(i for i, f in enumerate(findings) if f.span is None)
    assert all(f.span is None for f in findings[first_unspanned:])
    order = {rid: i for i, rid in enumerate(all_rule_ids())}
    tail = [order[f.rule_id] for f in findings[first_unspanned:]]
    assert tail == sorted(tail)


# ── FR-LINT-2: every rule cites a source or explicitly none ────────────────────────────────


@pytest.mark.parametrize("path", sorted(RULES_DIR.glob("*.yaml")), ids=lambda p: p.name)
def test_every_rule_has_a_source_or_explicit_null(path: Path) -> None:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    for rule in raw["rules"]:
        assert "source" in rule, rule["id"]
        src = rule["source"]
        assert src is None or (
            isinstance(src["provision"], str) and src["provision"] and "reference" in src
        ), rule["id"]


def test_rule_files_are_versioned_and_strict() -> None:
    raw = yaml.safe_load((RULES_DIR / "bail_application.yaml").read_text(encoding="utf-8"))
    assert isinstance(raw["version"], str) and raw["version"]
    parse_ruleset(copy.deepcopy(raw))  # the file itself parses

    def broken(edit: Callable[[dict[str, Any]], None]) -> None:
        bad = copy.deepcopy(raw)
        edit(bad)
        with pytest.raises(RulesetError):
            parse_ruleset(bad)

    broken(lambda r: r["rules"][0].pop("source"))
    broken(lambda r: r["rules"][0].update(colour="red"))
    broken(lambda r: r["rules"][0].update(kind="typo"))
    broken(lambda r: r["rules"][0].update(severity="fatal"))
    broken(lambda r: r["rules"][0].update(id="Bad Id"))
    broken(lambda r: r["rules"][1].update(id=r["rules"][0]["id"]))
    broken(lambda r: r["rules"][0].update(detect={"anyOf": ["(unclosed"]}))
    broken(lambda r: r["rules"][-1].update(detect={"order": ["bail.grounds", "nope"]}))
    broken(lambda r: r.pop("version"))


# ── FR-LINT-3: read-only ───────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", [BAIL_497, PLAINT])
def test_input_is_unchanged_and_hashed(name: str) -> None:
    text = SEEDED["bail.grounds" if name == BAIL_497 else "plaint.relief"][1](fixture(name))
    before = text.encode("utf-8")
    result = lint(DOC_TYPE[name], text)
    assert text.encode("utf-8") == before
    assert result.input_sha256 == hashlib.sha256(before).hexdigest()


def test_output_is_deterministic() -> None:
    text = "In the court of\nFIR\nprayer\n" * 50
    assert lint("bail_application", text) == lint("bail_application", text)
    assert lint("plaint", text) == lint("plaint", text)


def test_spans_are_utf16_offsets() -> None:
    # An emoji is two UTF-16 code units; Urdu letters are one each.
    prefix = "\U0001f600 درخواست\n"
    name, mutate = SEEDED["bail.fir_number"]
    text = prefix + mutate(fixture(name))
    (finding,) = lint("bail_application", text).findings
    assert finding.span is not None
    start, end = finding.span
    units = text.encode("utf-16-le")
    assert units[start * 2 : end * 2].decode("utf-16-le") == "FIR"
    assert utf16_offset(text, len(prefix)) == len(prefix) + 1


# ── the endpoints ──────────────────────────────────────────────────────────────────────────


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_rulesets_endpoint_matches_the_contract_and_the_engine(client: TestClient) -> None:
    resp = client.get("/ai/v1/lint/rulesets", headers=auth())
    assert resp.status_code == 200
    body = resp.json()
    conforms("LintRulesetList", body)
    assert [rs["id"] for rs in body["items"]] == ["bail_application", "plaint"]
    for served in body["items"]:
        rs = load_rulesets()[served["id"]]
        assert served["version"] == rs.version and served["documentType"] == rs.document_type
        assert [r["id"] for r in served["rules"]] == [r.id for r in rs.rules]
        for r in served["rules"]:
            assert set(r) == {"id", "kind", "severity", "title", "source"}


def test_lint_endpoint_matches_the_contract(client: TestClient) -> None:
    name, mutate = SEEDED["bail.fir_number"]
    text = "\U0001f600 درخواست\n" + mutate(fixture(name))
    request_id = str(uuid.uuid4())
    resp = client.post(
        "/ai/v1/lint",
        headers=auth(),
        json={"requestId": request_id, "documentType": "bail_application", "text": text},
    )
    assert resp.status_code == 200
    body = resp.json()
    conforms("LintResult", body)
    assert body["requestId"] == request_id
    assert (body["rulesetId"], body["rulesetVersion"]) == ("bail_application", "1")
    assert body["inputSha256"] == hashlib.sha256(text.encode("utf-8")).hexdigest()
    (finding,) = body["findings"]
    assert finding["ruleId"] == "bail.fir_number"
    assert text.encode("utf-16-le")[finding["span"]["start"] * 2 : finding["span"]["end"] * 2] == (
        "FIR".encode("utf-16-le")
    )


def test_lint_endpoint_null_span_and_null_source(client: TestClient) -> None:
    body = client.post(
        "/ai/v1/lint",
        headers=auth(),
        json={"requestId": str(uuid.uuid4()), "documentType": "plaint", "text": "hello"},
    ).json()
    conforms("LintResult", body)
    assert body["findings"] and all(f["span"] is None for f in body["findings"])
    assert {f["ruleId"] for f in body["findings"]} >= {"plaint.court_name", "plaint.relief"}


RID = "8f14e45f-ceea-4e7a-9f6b-3d1c2a7b5e10"


@pytest.mark.parametrize(
    ("payload", "field"),
    [
        ({"documentType": "plaint", "text": "x"}, "requestId"),
        ({"requestId": "nope", "documentType": "plaint", "text": "x"}, "requestId"),
        ({"requestId": RID, "documentType": "legal_notice", "text": "x"}, "documentType"),
        ({"requestId": RID, "documentType": "plaint", "text": ""}, "text"),
        ({"requestId": RID, "documentType": "plaint", "text": "x" * 200_001}, "text"),
        ({"requestId": RID, "documentType": "plaint", "text": "x", "extra": 1}, "extra"),
    ],
)
def test_lint_endpoint_rejects_bad_requests(
    client: TestClient, payload: dict[str, Any], field: str
) -> None:
    resp = client.post("/ai/v1/lint", headers=auth(), json=payload)
    assert resp.status_code == 400
    assert resp.headers["content-type"].startswith("application/problem+json")
    assert field in resp.json()["detail"]
    assert "x" * 50 not in resp.text  # the document's text is never echoed


def test_lint_endpoint_rejects_text_without_utf8_bytes(client: TestClient) -> None:
    # A JSON escape for a lone surrogate: valid JSON, but no UTF-8 encoding.
    raw = f'{{"requestId": "{uuid.uuid4()}", "documentType": "plaint", "text": "a\\ud800b"}}'
    resp = client.post(
        "/ai/v1/lint",
        headers={**auth(), "Content-Type": "application/json"},
        content=raw.encode("ascii"),
    )
    assert resp.status_code == 400
    assert "text" in resp.json()["detail"]


def test_lint_endpoints_need_the_service_token(client: TestClient) -> None:
    assert client.get("/ai/v1/lint/rulesets").status_code == 401
    resp = client.post(
        "/ai/v1/lint", json={"requestId": str(uuid.uuid4()), "documentType": "plaint", "text": "x"}
    )
    assert resp.status_code == 401
