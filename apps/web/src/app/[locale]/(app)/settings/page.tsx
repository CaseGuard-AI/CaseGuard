import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { SettingsForm } from "@/components/settings/settings-form";
import { pageMetadata } from "@/components/shell/coming-soon";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("settings");

export default function SettingsPage({ params }: PageProps<"/[locale]/settings">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Pages.settings");

  return (
    <>
      <PageIntro title={t("title")} subtitle={t("subtitle")} />
      <SettingsForm />
    </>
  );
}
