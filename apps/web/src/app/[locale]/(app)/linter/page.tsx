import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Suspense, use } from "react";
import { LinterScreen } from "@/components/linter/linter-screen";
import { pageMetadata } from "@/components/shell/coming-soon";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("linter");

// The procedural linter (FR-LINT-1, FR-LINT-2, FR-LINT-3). The screen reads `?case=` and
// `?report=`, so it renders inside Suspense (cacheComponents).
export default function LinterPage({ params }: PageProps<"/[locale]/linter">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Pages.linter");

  return (
    <>
      <PageIntro title={t("title")} subtitle={t("subtitle")} />
      <Suspense>
        <LinterScreen />
      </Suspense>
    </>
  );
}
