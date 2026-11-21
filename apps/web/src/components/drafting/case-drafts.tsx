"use client";

import { FilePlus2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { DraftsList } from "./drafts-list";

// The drafts card of the case dashboard (FR-CASE-4, FR-CASE-5). An archived case keeps its drafts,
// but new ones can't be saved to it, so the link is left out.
export function CaseDrafts({ caseId, archived }: { caseId: string; archived: boolean }) {
  const t = useTranslations("Drafting.card");
  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t("title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("body")}</p>
        </div>
        {!archived && (
          <Button variant="outline" size="sm" asChild>
            <Link href={`/drafting?case=${caseId}`}>
              <FilePlus2 aria-hidden />
              {t("new")}
            </Link>
          </Button>
        )}
      </div>
      <div className="mt-4">
        <DraftsList caseId={caseId} />
      </div>
    </section>
  );
}
