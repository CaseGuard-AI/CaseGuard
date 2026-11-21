"use client";

import { AlertCircle, AlertTriangle, BookOpen, Info, LocateFixed } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { KINDS, SEVERITIES, type LintFinding, type LintRuleset, type LintSeverity } from "./queries";

const SEVERITY_STYLE: Record<LintSeverity, string> = {
  error: "border-danger/20 bg-danger-soft text-danger",
  warning: "border-warning/20 bg-warning-soft text-warning",
  info: "border-border bg-muted text-muted-foreground",
};

const SEVERITY_ICON = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;

/** Findings per severity, for summaries. */
export function countFindings(findings: LintFinding[]): Record<LintSeverity, number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function SeverityCounts({ counts }: { counts: Record<LintSeverity, number> }) {
  const t = useTranslations("Linter.result");
  return (
    <span className="flex flex-wrap gap-2">
      {SEVERITIES.map((s) => (
        <span
          key={s}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px] font-medium",
            counts[s] > 0 ? SEVERITY_STYLE[s] : "border-border text-muted-foreground",
          )}
        >
          {t(s === "error" ? "errors" : s === "warning" ? "warnings" : "infos", {
            count: counts[s],
          })}
        </span>
      ))}
    </span>
  );
}

// The rule's source, or the explicit statement that none was identified (FR-LINT-2).
function SourceChip({ source }: { source: LintFinding["source"] }) {
  const t = useTranslations("Linter.result");
  if (!source)
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] text-muted-foreground">
        {t("noSource")}
      </span>
    );
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-[11px] font-medium"
      title={t("sourceLabel")}
    >
      <BookOpen className="size-3" aria-hidden />
      <span className="sr-only">{t("sourceLabel")}: </span>
      <span dir="ltr">{source.provision}</span>
    </span>
  );
}

/**
 * The findings grouped by kind, each group in severity order (FR-LINT-1). A finding with a span
 * is a button that highlights it in the text; `selected` is its index in `findings`.
 */
export function FindingsList({
  findings,
  ruleset,
  selected,
  onSelect,
}: {
  findings: LintFinding[];
  ruleset?: LintRuleset;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const t = useTranslations("Linter.result");
  const titleOf = (ruleId: string) => ruleset?.rules.find((r) => r.id === ruleId)?.title;
  const indexed = findings.map((finding, index) => ({ finding, index }));

  return (
    <div className="space-y-5">
      {KINDS.map((kind) => {
        const group = indexed
          .filter(({ finding }) => finding.kind === kind)
          .sort(
            (a, b) =>
              SEVERITIES.indexOf(a.finding.severity) - SEVERITIES.indexOf(b.finding.severity) ||
              a.index - b.index,
          );
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-label={t(`kinds.${kind}`)}>
            <h3 className="mb-2 text-sm font-semibold">
              {t(`kinds.${kind}`)} <span className="text-muted-foreground">({group.length})</span>
            </h3>
            <ul className="space-y-2">
              {group.map(({ finding, index }) => {
                const Icon = SEVERITY_ICON[finding.severity];
                const title = titleOf(finding.ruleId);
                const body = (
                  <>
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                          SEVERITY_STYLE[finding.severity],
                        )}
                      >
                        <Icon className="size-3" aria-hidden />
                        {t(`severity.${finding.severity}`)}
                      </span>
                      {title && (
                        <span className="text-xs font-medium" dir="ltr">
                          {title}
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-sm" dir="ltr">
                      {finding.message}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      <SourceChip source={finding.source} />
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        {finding.span ? (
                          <>
                            <LocateFixed className="size-3" aria-hidden />
                            {t(selected === index ? "highlighted" : "showInText")}
                          </>
                        ) : (
                          t("wholeDocument")
                        )}
                      </span>
                    </span>
                  </>
                );
                const frame = cn(
                  "block w-full rounded-md border p-3 text-start",
                  selected === index && "border-primary ring-2 ring-primary/30",
                );
                return (
                  <li key={index}>
                    {finding.span ? (
                      <button
                        type="button"
                        className={cn(frame, "transition-colors hover:bg-accent")}
                        aria-pressed={selected === index}
                        onClick={() => onSelect(index)}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className={frame}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
