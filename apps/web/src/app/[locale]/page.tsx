import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { ApiStatus } from "@/components/api-status";
import { TrustBadge } from "@/components/trust-badge";

export default function Home({ params }: PageProps<"/[locale]">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Home");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-12">
      <h1 className="text-3xl font-semibold">{t("heading")}</h1>
      <textarea
        disabled
        rows={3}
        placeholder={t("placeholder")}
        className="w-full rounded-lg border border-zinc-300 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900"
      />
      <p className="text-zinc-600 dark:text-zinc-400">{t("comingSoon")}</p>
      <div className="flex flex-wrap gap-2">
        <TrustBadge status="verified" />
        <TrustBadge status="needs_review" />
        <TrustBadge status="unverified" />
      </div>
      <ApiStatus />
    </main>
  );
}
