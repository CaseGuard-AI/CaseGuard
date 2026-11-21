"""The drafting templates (FR-DRAFT-1, ai.v1 ``DraftTemplate``).

Each template is a YAML file in ``templates/``, validated once when first loaded: a bad file
fails here, never in a route. The order of the files is the order of ``listDraftTemplates``.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path
from typing import Annotated, Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

TEMPLATE_DIR = Path(__file__).parent / "templates"
TEMPLATE_IDS = ("bail_application", "plaint", "legal_notice")  # ai.v1 DraftTemplateId

TemplateId = Literal["bail_application", "plaint", "legal_notice"]
CaseField = Literal[
    "title",
    "court",
    "caseNumber",
    "caseType",
    "filedOn",
    "status",
    "nextHearingOn",
    "parties",
    "judge",
    "assignedLawyer",
    "relevantLaws",
    "summary",
]
Key = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,63}$")]


class TemplateField(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    key: Key
    label: Annotated[str, Field(min_length=1)]
    required: bool
    caseField: CaseField | None


class TemplateSection(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    key: Key
    heading: Annotated[str, Field(min_length=1)]
    required: bool
    assistable: bool
    guidance: Annotated[str, Field(min_length=1)]


class Template(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: TemplateId
    version: Annotated[str, Field(min_length=1)]
    title: Annotated[str, Field(min_length=1)]
    description: Annotated[str, Field(min_length=1)]
    fields: tuple[TemplateField, ...]
    sections: Annotated[tuple[TemplateSection, ...], Field(min_length=1)]

    @model_validator(mode="after")
    def _unique_keys(self) -> Template:
        for kind, keys in (
            ("field", [f.key for f in self.fields]),
            ("section", [s.key for s in self.sections]),
        ):
            if len(set(keys)) != len(keys):
                raise ValueError(f"{self.id}: duplicate {kind} keys")
        return self

    def section(self, key: str) -> TemplateSection | None:
        return next((s for s in self.sections if s.key == key), None)

    def dto(self) -> dict[str, Any]:
        return self.model_dump(mode="json")


@cache
def templates() -> tuple[Template, ...]:
    out = []
    for template_id in TEMPLATE_IDS:
        raw = yaml.safe_load((TEMPLATE_DIR / f"{template_id}.yaml").read_text(encoding="utf-8"))
        template = Template.model_validate(raw)
        if template.id != template_id:
            raise ValueError(f"{template_id}.yaml declares id {template.id}")
        out.append(template)
    return tuple(out)


def get_template(template_id: str) -> Template | None:
    return next((t for t in templates() if t.id == template_id), None)
