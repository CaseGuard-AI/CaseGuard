import type { LintDocumentType } from "@/components/linter/queries";
import type { DraftTemplate, DraftTemplateId } from "./queries";

const LINTABLE: Partial<Record<DraftTemplateId, LintDocumentType>> = {
  bail_application: "bail_application",
  plaint: "plaint",
};

/** The linter's document type for a template, or null when there is no rule set (legal notice). */
export const lintTypeOf = (templateId: DraftTemplateId): LintDocumentType | null =>
  LINTABLE[templateId] ?? null;

const MARKER = /\[\[c:[^\]\s]+\]\]/g;

/**
 * The draft as one text for the linter (FR-LINT-1): the title, the particulars as "Label: value"
 * lines (the FIR number, police station and so on live there, not in the sections), then each
 * section under its template heading, in template order. Citation markers are dropped; empty
 * fields and sections are left out so the linter reports them as missing.
 */
export function draftLintText(
  template: DraftTemplate,
  draft: { title: string; fields: Record<string, string | null>; sections: Record<string, string> },
): string {
  const blocks = [draft.title.trim()];
  const particulars = template.fields
    .map((f) => [f.label, draft.fields[f.key]?.trim()] as const)
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  if (particulars.length) blocks.push(particulars.join("\n"));
  for (const s of template.sections) {
    const body = (draft.sections[s.key] ?? "").replace(MARKER, "").trim();
    if (body) blocks.push(`${s.heading}\n${body}`);
  }
  return blocks.filter(Boolean).join("\n\n");
}
