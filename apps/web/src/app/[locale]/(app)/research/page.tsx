import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Suspense, use } from "react";
import { ResearchHub } from "@/components/research/research-hub";
import { pageMetadata } from "@/components/shell/page-metadata";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("research");

export default function ResearchPage({ params }: PageProps<"/[locale]/research">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Pages.research");

  return (
    <>
      <PageIntro title={t("title")} subtitle={t("subtitle")} />
      {/* The hub reads `?c=`, which needs a Suspense boundary for static rendering. */}
      <Suspense>
        <ResearchHub />
      </Suspense>
    </>
  );
}
