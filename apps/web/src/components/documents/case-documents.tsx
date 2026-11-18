"use client";

import { useTranslations } from "next-intl";
import { DocumentsList } from "./documents-list";
import { DocumentUploader } from "./uploader";

// The documents card of the case dashboard (FR-CASE-4). An archived case keeps its files, but the
// API takes no new ones, so the uploader is left out.
export function CaseDocuments({ caseId, archived }: { caseId: string; archived: boolean }) {
  const t = useTranslations("Documents.card");
  return (
    <section className="rounded-md border bg-card p-5 sm:p-6">
      <h2 className="text-base font-semibold">{t("title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t(archived ? "bodyArchived" : "body")}
      </p>
      <div className="mt-4 space-y-4">
        {!archived && <DocumentUploader caseId={caseId} />}
        <DocumentsList caseId={caseId} />
      </div>
    </section>
  );
}
