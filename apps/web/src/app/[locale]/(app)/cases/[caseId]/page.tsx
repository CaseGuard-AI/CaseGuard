import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { CaseDashboard } from "@/components/cases/case-dashboard";
import { pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("cases");

export default function CasePage({ params }: PageProps<"/[locale]/cases/[caseId]">) {
  const { locale, caseId } = use(params);
  setRequestLocale(locale);
  return <CaseDashboard caseId={caseId} />;
}
