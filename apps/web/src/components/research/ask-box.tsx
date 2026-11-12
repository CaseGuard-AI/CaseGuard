"use client";

import { LoaderCircle, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";

/** Today in the user's time zone, as YYYY-MM-DD: no "law as of" date in the future. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function AskBox({
  pending,
  error,
  onAsk,
}: {
  pending: boolean;
  error?: string;
  /** `lawAsOf` is the optional "law as of" date, YYYY-MM-DD (FR-RES-11). */
  onAsk: (question: string, lawAsOf?: string) => Promise<boolean>;
}) {
  const t = useTranslations("Research");
  const [question, setQuestion] = useState("");
  // Kept after a question is sent, so follow-ups ask about the same date.
  const [lawAsOf, setLawAsOf] = useState("");
  const hintId = useId();
  const dateId = useId();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || pending) return;
    if (await onAsk(trimmed, lawAsOf || undefined)) setQuestion("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
  }

  return (
    <form onSubmit={submit} className="rounded-md border bg-card p-4">
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-sm border border-danger/20 bg-danger-soft p-3 text-sm text-danger"
        >
          {error}
        </p>
      )}
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-4 top-4 size-5 text-muted-foreground"
          aria-hidden
        />
        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t("placeholder")}
          aria-describedby={hintId}
          placeholder={t("placeholder")}
          maxLength={4000}
          dir="auto"
          className="min-h-24 w-full resize-none rounded-md border bg-background py-3 ps-12 pe-4 pb-14 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button
          type="submit"
          className="absolute end-3 bottom-3"
          disabled={pending || !question.trim()}
        >
          {pending && <LoaderCircle className="animate-spin" aria-hidden />}
          {t("submit")}
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p id={hintId} className="text-[11px] text-muted-foreground">
          {t("shortcut")}
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor={dateId} className="text-xs text-muted-foreground">
            {t("lawAsOf")}
          </label>
          <input
            id={dateId}
            type="date"
            value={lawAsOf}
            max={today()}
            onChange={(event) => setLawAsOf(event.target.value)}
            className="rounded-sm border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>
    </form>
  );
}
