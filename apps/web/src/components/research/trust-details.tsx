"use client";

import { Clock3 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { Schemas } from "@/lib/api";
import { cn } from "@/lib/utils";

type Flag = Schemas["Verification"]["flags"][number];

// Flags that force "needs review" in the trust layer (PRD §7). The rest are informational.
const blocking: ReadonlySet<Flag> = new Set([
  "overruled",
  "repealed",
  "superseded_version",
  "conflict",
]);

/** "Last verified <date>", next to every status (FR-TRUST-5). */
export function LastVerified({ at }: { at: string }) {
  const t = useTranslations("Trust");
  const format = useFormatter();
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
      <Clock3 className="size-3" aria-hidden />
      {t("lastVerified", { date: format.dateTime(new Date(at), { dateStyle: "medium" }) })}
    </span>
  );
}

export function FlagChips({ flags }: { flags: readonly Flag[] }) {
  const t = useTranslations("Trust.flags");
  if (flags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {flags.map((flag) => (
        <li
          key={flag}
          data-flag={flag}
          className={cn(
            "rounded-sm border px-2 py-0.5 text-[10px] font-semibold",
            blocking.has(flag)
              ? "border-warning/20 bg-warning-soft text-warning"
              : "border-border bg-muted text-muted-foreground",
          )}
        >
          {t(flag)}
        </li>
      ))}
    </ul>
  );
}
