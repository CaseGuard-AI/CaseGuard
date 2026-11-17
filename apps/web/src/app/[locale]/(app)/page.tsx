import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { Dashboard } from "@/components/dashboard/dashboard";
import { PageIntro } from "@/components/shell/page-intro";

export default function Home({ params }: PageProps<"/[locale]">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro title={t("Pages.dashboard.title")} subtitle={t("Pages.dashboard.subtitle")} />
      <Dashboard />
    </>
  );
}
