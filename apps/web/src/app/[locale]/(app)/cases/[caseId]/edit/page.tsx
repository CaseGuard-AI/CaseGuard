import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { CaseEdit } from "@/components/cases/case-edit";
import { pageMetadata } from "@/components/shell/page-metadata";

export const generateMetadata = pageMetadata("cases");

export default function EditCasePage({ params }: PageProps<"/[locale]/cases/[caseId]/edit">) {
  const { locale, caseId } = use(params);
  setRequestLocale(locale);
  return <CaseEdit caseId={caseId} />;
}
