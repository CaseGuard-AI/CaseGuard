// Fill a new draft's fields from its case (FR-DRAFT-2, ai.v1 CaseField).
import type { CaseField, DraftTemplate } from "../clients/ai.js";
import type { Case, Party } from "../db/schema.js";

const MAX_FIELD = 4000; // api.v1 Draft.fields maxLength

/** A party as one line: `Name (Label)`, or the side when the court's label is unknown. */
export function partyLine(p: Party): string {
  const label = p.label?.trim() || (p.side === "claimant" ? "Claimant" : "Respondent");
  return `${p.name} (${label})`;
}

/** One case field as text: list fields one line per entry; null when empty. */
export function caseValue(c: Case, field: CaseField): string | null {
  let value: string | null;
  switch (field) {
    case "parties":
      value = c.parties.map(partyLine).join("\n");
      break;
    case "relevantLaws":
      value = c.relevantLaws.join("\n");
      break;
    default:
      value = c[field] ?? null;
  }
  if (!value) return null;
  return value.length > MAX_FIELD ? value.slice(0, MAX_FIELD) : value;
}

/** Every template field by key: from the case where it has a caseField, else null. */
export function fillFields(
  template: DraftTemplate,
  fromCase: Case | undefined,
): Record<string, string | null> {
  return Object.fromEntries(
    template.fields.map((f) => [
      f.key,
      fromCase && f.caseField ? caseValue(fromCase, f.caseField) : null,
    ]),
  );
}

/** Every template section, in order, with the saved body or "" (api.v1 Draft.sections). */
export function orderSections(
  template: DraftTemplate,
  saved: { key: string; body: string }[],
): { key: string; body: string }[] {
  const bodies = new Map(saved.map((s) => [s.key, s.body]));
  return template.sections.map((s) => ({ key: s.key, body: bodies.get(s.key) ?? "" }));
}
