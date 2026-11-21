import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { PrecedentSearch } from "@/components/precedents/precedent-search";
import { pageMetadata } from "@/components/shell/coming-soon";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("precedents");

// Precedent search (FR-PREC-1, ADR-0011): retrieved judgments and the judgments the knowledge
// graph links them to, each labelled by origin (FR-PREC-3), with their relationships (FR-PREC-4).
export default function PrecedentsPage({ params }: PageProps<"/[locale]/precedents">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro title={t("Pages.precedents.title")} subtitle={t("Pages.precedents.subtitle")} />
      <PrecedentSearch />
    </>
  );
}
