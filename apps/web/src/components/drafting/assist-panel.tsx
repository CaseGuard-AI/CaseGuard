"use client";

import { LoaderCircle, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Citation } from "@/components/research/queries";
import type { Numbered } from "@/components/research/sources-list";
import { assistErrorKey, useAssist, type DraftAssist } from "./queries";
import { MarkedText, SectionCitations, numberedCitations } from "./section-citations";

// AI drafting for one section (FR-DRAFT-3). The suggestion's citations come from the trust
// store and are drawn as in research (FR-TRUST-10). Nothing changes until the user inserts or
// replaces, and nothing is saved until Save.
export function AssistPanel({
  draftId,
  sectionKey,
  heading,
  onUse,
  onOpen,
}: {
  draftId: string;
  sectionKey: string;
  heading: string;
  onUse: (result: DraftAssist, mode: "insert" | "replace") => void;
  onOpen: (item: Numbered) => void;
}) {
  const t = useTranslations("Drafting.assist");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const assist = useAssist(draftId, sectionKey);
  const result = assist.data;
  const known = useMemo(
    () => new Map<string, Citation>((result?.citations ?? []).map((c) => [c.id, c])),
    [result],
  );

  if (!open)
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden />
        {t("open")}
      </Button>
    );

  const use = (mode: "insert" | "replace") => {
    if (!result) return;
    onUse(result, mode);
    assist.reset();
    setInstruction("");
    setOpen(false);
  };

  return (
    <div
      role="region"
      aria-label={t("label", { heading })}
      className="space-y-3 rounded-md border border-info/20 bg-info-soft p-3"
    >
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          assist.mutate(instruction.trim());
        }}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <label htmlFor={id} className="text-xs font-medium">
            {t("instruction")}
          </label>
          <Input
            id={id}
            value={instruction}
            maxLength={2000}
            placeholder={t("instructionPlaceholder")}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={assist.isPending}>
            {assist.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden />
            ) : (
              <Sparkles aria-hidden />
            )}
            {t(result ? "again" : "run")}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            {t("close")}
          </Button>
        </div>
      </form>
      {assist.isPending && (
        <p aria-busy="true" className="text-xs text-muted-foreground">
          {t("working")}
        </p>
      )}
      {assist.isError && (
        <p role="alert" className="text-sm text-danger">
          {t(`errors.${assistErrorKey(assist.error)}`)}
        </p>
      )}
      {result && (
        <div className="space-y-3 rounded-sm border bg-card p-3">
          <p className="text-xs font-bold text-link uppercase">{t("suggestion")}</p>
          {result.text.trim() ? (
            <MarkedText text={result.text} known={known} onOpen={onOpen} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          )}
          <SectionCitations
            items={numberedCitations(result.text, known)}
            onOpen={onOpen}
            label={t("citations")}
          />
          {result.text.trim() && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => use("insert")}>
                {t("insert")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => use("replace")}>
                {t("replace")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
