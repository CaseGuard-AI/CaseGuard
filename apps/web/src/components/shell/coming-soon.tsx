import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import type { PageKey } from "./nav-items";
import { PageIntro } from "./page-intro";

type Params = Promise<{ locale: string }>;

// Placeholder for prototype screens that are not built yet. Each screen's issue replaces it.
export function ComingSoon({ params, page }: { params: Params; page: PageKey }) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro title={t(`Pages.${page}.title`)} subtitle={t(`Pages.${page}.subtitle`)} />
      <div className="rounded-md border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        {t("Common.comingSoon")}
      </div>
    </>
  );
}
