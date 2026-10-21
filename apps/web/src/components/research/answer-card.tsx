"use client";

import { Bot, Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { dirOf, langOf } from "@/lib/language";
import { CitationChip } from "./citation-chip";
import { parseAnswer } from "./markers";
import type { Message } from "./queries";
import { SourcesList, type Numbered } from "./sources-list";

// One assistant answer with its evidence column. The text is rendered as plain text, so model
// output can't inject markup. It keeps the answer's own language and direction.
export function AnswerCard({
  message,
  onOpen,
}: {
  message: Message;
  onOpen: (item: Numbered) => void;
}) {
  const t = useTranslations("Research");
  const citations = useMemo(() => message.citations ?? [], [message.citations]);
  const { paragraphs, order } = useMemo(
    () =>
      parseAnswer(
        message.text,
        citations.map((c) => c.id),
      ),
    [message.text, citations],
  );
  const byId = new Map(citations.map((c) => [c.id, c]));
  const items: Numbered[] = order.map((id, i) => ({ citation: byId.get(id)!, n: i + 1 }));
  const answerable = message.answerable !== false;

  const text = (
    <div
      lang={langOf(message.language)}
      dir={dirOf(message.language)}
      className="space-y-4 text-sm leading-7 whitespace-pre-line text-foreground/80"
    >
      {paragraphs.map((segments, p) => (
        <p key={p}>
          {segments.map((segment, s) =>
            "text" in segment ? (
              <span key={s}>{segment.text}</span>
            ) : (
              <CitationChip
                key={s}
                citation={byId.get(segment.citationId)!}
                n={segment.n}
                onOpen={() => onOpen(items[segment.n - 1])}
              />
            ),
          )}
        </p>
      ))}
    </div>
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
      <article className="rounded-md border bg-card p-6">
        <p className="mb-5 flex items-center gap-2 text-xs font-bold text-primary uppercase">
          <Bot className="size-4" aria-hidden />
          {t("analysis")}
        </p>
        {answerable ? (
          text
        ) : (
          <div role="note" className="flex gap-3 rounded-sm border border-info/20 bg-info-soft p-4">
            <Info className="mt-1 size-4 shrink-0 text-info" aria-hidden />
            <div className="space-y-2">
              <p className="text-sm font-semibold">{t("unanswerable")}</p>
              {text}
            </div>
          </div>
        )}
      </article>
      {answerable && items.length > 0 && <SourcesList items={items} onOpen={onOpen} />}
    </div>
  );
}
