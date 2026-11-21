"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { CitationChip } from "@/components/research/citation-chip";
import { parseAnswer } from "@/components/research/markers";
import { useCitation, type Citation } from "@/components/research/queries";
import type { Numbered } from "@/components/research/sources-list";
import { FlagChips, LastVerified } from "@/components/research/trust-details";

/** The citations marked in `text`, numbered by first appearance, from those known. */
export function numberedCitations(text: string, known: ReadonlyMap<string, Citation>): Numbered[] {
  const { order } = parseAnswer(text, [...known.keys()]);
  const marked = new Set([...text.matchAll(/\[\[c:([^\]\s]+)\]\]/g)].map((m) => m[1]));
  return order
    .filter((id) => marked.has(id))
    .map((id, i) => ({ citation: known.get(id)!, n: i + 1 }));
}

// The citations a section's text carries, each with its stored status, flags and last-verified
// date, drawn with the research chips so a status looks the same everywhere (FR-TRUST-10).
export function SectionCitations({
  items,
  onOpen,
  label,
}: {
  items: Numbered[];
  onOpen: (item: Numbered) => void;
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className="space-y-1.5">
      {items.map((item) => (
        <CitationRow key={item.citation.id} item={item} onOpen={() => onOpen(item)} />
      ))}
    </ul>
  );
}

function CitationRow({ item, onOpen }: { item: Numbered; onOpen: () => void }) {
  const t = useTranslations("Drafting.citations");
  const { verification, claim, locator } = useCitation(item.citation).data;
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs">
      <CitationChip citation={item.citation} n={item.n} onOpen={onOpen} />
      <span className="min-w-0 truncate text-foreground/80" dir="auto">
        {locator ? t("at", { locator, claim }) : claim}
      </span>
      <LastVerified at={verification.lastVerifiedAt} />
      <FlagChips flags={verification.flags} />
    </li>
  );
}

/** The text with its markers turned into chips, as research shows an answer. */
export function MarkedText({
  text,
  known,
  onOpen,
}: {
  text: string;
  known: ReadonlyMap<string, Citation>;
  onOpen: (item: Numbered) => void;
}) {
  const { paragraphs } = useMemo(() => parseAnswer(text, [...known.keys()]), [text, known]);
  return (
    <div className="space-y-3 text-sm leading-7 whitespace-pre-line text-foreground/80" dir="auto">
      {paragraphs.map((segments, p) => (
        <p key={p}>
          {segments.map((segment, s) =>
            "text" in segment ? (
              <span key={s}>{segment.text}</span>
            ) : (
              <CitationChip
                key={s}
                citation={known.get(segment.citationId)!}
                n={segment.n}
                onOpen={() => onOpen({ citation: known.get(segment.citationId)!, n: segment.n })}
              />
            ),
          )}
        </p>
      ))}
    </div>
  );
}
