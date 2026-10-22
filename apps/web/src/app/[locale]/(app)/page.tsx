import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { ApiStatus } from "@/components/api-status";
import { PageIntro } from "@/components/shell/page-intro";
import { TrustBadge } from "@/components/trust-badge";

export default function Home({ params }: PageProps<"/[locale]">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro title={t("Pages.dashboard.title")} subtitle={t("Pages.dashboard.subtitle")} />
      <section className="flex max-w-3xl flex-col gap-4 rounded-md border bg-card p-5">
        <h2 className="text-sm font-bold">{t("Home.heading")}</h2>
        <textarea
          disabled
          rows={3}
          placeholder={t("Home.placeholder")}
          className="w-full rounded-md border border-input bg-muted/60 p-3 text-sm"
        />
        <p className="text-sm text-muted-foreground">{t("Home.comingSoon")}</p>
        <div className="flex flex-wrap gap-2">
          <TrustBadge status="verified" />
          <TrustBadge status="needs_review" />
          <TrustBadge status="unverified" />
        </div>
        <ApiStatus />
      </section>
    </>
  );
}
