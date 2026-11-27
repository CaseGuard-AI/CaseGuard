import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { CaseForm } from "@/components/cases/case-form";
import { pageMetadata } from "@/components/shell/page-metadata";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("cases");

export default function NewCasePage({ params }: PageProps<"/[locale]/cases/new">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Cases.form");

  return (
    <>
      <PageIntro title={t("createTitle")} subtitle={t("createSubtitle")} />
      <CaseForm />
    </>
  );
}
