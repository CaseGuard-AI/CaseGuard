"use client";

import { Briefcase, LoaderCircle, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { isMissing, useCase, useCases } from "@/components/cases/queries";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { statusOf } from "@/lib/api-query";
import { useSaveToCase, type ConversationSummary } from "./queries";

/** Whether a new question can be saved to the case in `?case=`: unknown while it loads. */
export function useCaseAvailable(caseId: string | null) {
  const found = useCase(caseId);
  if (!caseId) return false;
  if (isMissing(found.error)) return false;
  return found.data ? found.data.archivedAt === null : true;
}

// Shown above the ask box when a new question will start in a case (`/research?case=<id>`).
export function NewCaseChip({ caseId, onClear }: { caseId: string; onClear: () => void }) {
  const t = useTranslations("Cases.research");
  const found = useCase(caseId);
  const unavailable = isMissing(found.error) || (found.data && found.data.archivedAt !== null);

  if (unavailable) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 rounded-sm border bg-muted p-3 text-sm"
      >
        <p className="text-muted-foreground">{t("unavailable")}</p>
        <Button variant="link" size="sm" className="px-0" onClick={onClear}>
          {t("clear")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 ps-3 pe-1">
        <Briefcase className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">{t("askingIn")}</span>
        {found.data ? (
          <Link
            href={`/cases/${caseId}`}
            className="truncate font-semibold hover:underline"
            dir="auto"
          >
            {found.data.title}
          </Link>
        ) : (
          <LoaderCircle className="size-3 animate-spin" aria-label={t("loading")} />
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-full"
          aria-label={t("clear")}
          onClick={onClear}
        >
          <X aria-hidden />
        </Button>
      </span>
    </div>
  );
}

/**
 * A select of the user's active cases, plus "none" (FR-CASE-5). `current`, if it isn't an active
 * case (it was archived), stays listed so the select can show it. Shared by the Research Hub and
 * the linter's "Save to case".
 */
export function CaseSelect({
  id,
  value,
  current = null,
  pending = false,
  onChange,
}: {
  id: string;
  value: string;
  current?: string | null;
  pending?: boolean;
  onChange: (caseId: string | null) => void;
}) {
  const t = useTranslations("Cases.research");
  const active = useCases("active");
  const options = active.data?.pages.flatMap((page) => page.items) ?? [];
  const currentCase = useCase(current && !options.some((c) => c.id === current) ? current : null);

  return (
    <select
      id={id}
      value={value}
      disabled={pending}
      aria-busy={pending || undefined}
      onChange={(event) => onChange(event.target.value || null)}
      className="h-8 max-w-64 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-50"
    >
      <option value="">{t("none")}</option>
      {current && !options.some((c) => c.id === current) && (
        <option value={current}>
          {currentCase.data
            ? currentCase.data.archivedAt
              ? t("archivedOption", { title: currentCase.data.title })
              : currentCase.data.title
            : t("loading")}
        </option>
      )}
      {options.map((c) => (
        <option key={c.id} value={c.id}>
          {c.title}
        </option>
      ))}
    </select>
  );
}

// Saves the open conversation to a case, moves it, or detaches it (FR-CASE-5). The choices are
// the user's active cases; a conversation already in an archived case keeps that one listed.
export function CasePicker({ conversation }: { conversation: ConversationSummary }) {
  const t = useTranslations("Cases.research");
  const id = useId();
  const save = useSaveToCase(conversation.id);
  const current = conversation.caseId ?? null;
  const value = save.isPending ? (save.variables ?? "") : (current ?? "");

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Briefcase className="size-4 text-muted-foreground" aria-hidden />
      <label htmlFor={id} className="text-muted-foreground">
        {t("saveLabel")}
      </label>
      <CaseSelect
        id={id}
        value={value}
        current={current}
        pending={save.isPending}
        onChange={(caseId) => save.mutate(caseId)}
      />
      {current && (
        <Link href={`/cases/${current}`} className="text-xs text-primary hover:underline">
          {t("openCase")}
        </Link>
      )}
      {save.isError && (
        <p role="alert" className="w-full text-xs text-danger">
          {t(statusOf(save.error) === undefined ? "network" : "saveError")}
        </p>
      )}
    </div>
  );
}
