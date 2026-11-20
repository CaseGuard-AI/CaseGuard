"""``GET /ai/v1/lint/rulesets`` and ``POST /ai/v1/lint`` (ai.v1 ``listLintRulesets`` and
``lintDocument``). Neither touches the database or a model provider (ADR-0012)."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from caseguard_ai.linter.engine import Finding, lint
from caseguard_ai.linter.rules import Kind, Rule, Ruleset, Severity, Source, load_rulesets
from caseguard_ai.security import require_service_token

router = APIRouter(prefix="/ai/v1", tags=["linter"], dependencies=[Depends(require_service_token)])


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", alias_generator=to_camel, populate_by_name=True)


class LintRequest(_Model):
    request_id: uuid.UUID
    document_type: Literal["bail_application", "plaint"]
    text: Annotated[str, Field(min_length=1, max_length=200_000)]

    @field_validator("text")
    @classmethod
    def _has_utf8_bytes(cls, value: str) -> str:
        # A lone surrogate (JSON "\ud800") has no UTF-8 encoding, so nothing to hash.
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            raise ValueError("not valid Unicode") from None
        return value


class LintRuleSourceOut(_Model):
    provision: str
    reference: uuid.UUID | None


class LintRuleOut(_Model):
    id: str
    kind: Kind
    severity: Severity
    title: str
    source: LintRuleSourceOut | None


class LintRulesetOut(_Model):
    id: str
    document_type: Literal["bail_application", "plaint"]
    version: str
    title: str
    rules: list[LintRuleOut]


class LintRulesetListOut(_Model):
    items: list[LintRulesetOut]


class LintSpanOut(_Model):
    start: int
    end: int


class LintFindingOut(_Model):
    rule_id: str
    kind: Kind
    severity: Severity
    message: str
    span: LintSpanOut | None
    source: LintRuleSourceOut | None


class LintResultOut(_Model):
    request_id: uuid.UUID
    ruleset_id: str
    ruleset_version: str
    input_sha256: str
    findings: list[LintFindingOut]


def _source(source: Source | None) -> LintRuleSourceOut | None:
    if source is None:
        return None
    ref = uuid.UUID(source.reference) if source.reference else None
    return LintRuleSourceOut(provision=source.provision, reference=ref)


def _rule(rule: Rule) -> LintRuleOut:
    return LintRuleOut(
        id=rule.id,
        kind=rule.kind,
        severity=rule.severity,
        title=rule.title,
        source=_source(rule.source),
    )


def _ruleset(rs: Ruleset) -> LintRulesetOut:
    return LintRulesetOut(
        id=rs.id,
        document_type=rs.document_type,
        version=rs.version,
        title=rs.title,
        rules=[_rule(r) for r in rs.rules],
    )


def _finding(f: Finding) -> LintFindingOut:
    span = LintSpanOut(start=f.span[0], end=f.span[1]) if f.span else None
    return LintFindingOut(
        rule_id=f.rule_id,
        kind=f.kind,
        severity=f.severity,
        message=f.message,
        span=span,
        source=_source(f.source),
    )


@router.get("/lint/rulesets", response_model=LintRulesetListOut, response_model_by_alias=True)
def list_lint_rulesets() -> LintRulesetListOut:
    return LintRulesetListOut(items=[_ruleset(rs) for rs in load_rulesets().values()])


@router.post("/lint", response_model=LintResultOut, response_model_by_alias=True)
def lint_document(body: LintRequest) -> LintResultOut:
    outcome = lint(body.document_type, body.text)
    return LintResultOut(
        request_id=body.request_id,
        ruleset_id=outcome.ruleset_id,
        ruleset_version=outcome.ruleset_version,
        input_sha256=outcome.input_sha256,
        findings=[_finding(f) for f in outcome.findings],
    )
