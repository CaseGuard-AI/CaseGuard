"use client";

import { useTranslations } from "next-intl";
import { PageIntro } from "@/components/shell/page-intro";
import { CaseForm } from "./case-form";
import { useCase } from "./queries";
import { CaseLoadState } from "./states";

// `/cases/[caseId]/edit`: the case form filled with the saved case. An archived case can still
// be edited (api.v1 `updateCase`).
export function CaseEdit({ caseId }: { caseId: string }) {
  const t = useTranslations("Cases.form");
  const found = useCase(caseId);

  if (!found.isSuccess)
    return (
      <CaseLoadState
        pending={found.isPending}
        error={found.error}
        onRetry={() => void found.refetch()}
      />
    );

  return (
    <>
      <PageIntro title={t("editTitle")} subtitle={found.data.title} />
      <CaseForm key={found.data.updatedAt} initial={found.data} />
    </>
  );
}
