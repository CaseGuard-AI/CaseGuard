"use client";

import { useEffect, useRef } from "react";

/**
 * The linted text, read-only and exactly as stored (FR-LINT-3), with `span` highlighted. Spans are
 * UTF-16 offsets (api.v1 LintSpan), which is how JavaScript indexes strings, so `slice` is exact.
 */
export function TextView({
  text,
  span,
  label,
}: {
  text: string;
  span: { start: number; end: number } | null;
  label: string;
}) {
  const mark = useRef<HTMLElement>(null);

  useEffect(() => {
    // jsdom has no scrollIntoView; browsers do.
    mark.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [span?.start, span?.end]);

  const start = span ? Math.min(span.start, text.length) : 0;
  const end = span ? Math.min(Math.max(span.end, start), text.length) : 0;

  return (
    <pre
      aria-label={label}
      tabIndex={0}
      dir="auto"
      className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-4 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap"
    >
      {span ? (
        <>
          {text.slice(0, start)}
          <mark
            ref={mark}
            data-testid="lint-highlight"
            className="rounded-sm bg-warning-soft px-0.5 text-foreground ring-2 ring-warning/40"
          >
            {/* An empty span still shows where the problem is. */}
            {text.slice(start, end) || "​"}
          </mark>
          {text.slice(end)}
        </>
      ) : (
        text
      )}
    </pre>
  );
}
