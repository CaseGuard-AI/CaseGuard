"use client";

import { LoaderCircle, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";

export function AskBox({
  pending,
  error,
  onAsk,
}: {
  pending: boolean;
  error?: string;
  onAsk: (question: string) => Promise<boolean>;
}) {
  const t = useTranslations("Research");
  const [question, setQuestion] = useState("");
  const hintId = useId();

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || pending) return;
    if (await onAsk(trimmed)) setQuestion("");
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
      <p id={hintId} className="mt-2 text-[11px] text-muted-foreground">
        {t("shortcut")}
      </p>
    </form>
  );
}
