import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Suspense, use } from "react";
import { AdminConsole } from "@/components/admin/admin-console";
import { pageMetadata } from "@/components/shell/coming-soon";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("admin");

export default function AdminPage({ params }: PageProps<"/[locale]/admin">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("Pages.admin");

  return (
    <>
      <PageIntro title={t("title")} subtitle={t("subtitle")} />
      {/* The console reads `?tab=`, which needs a Suspense boundary for static rendering. */}
      <Suspense>
        <AdminConsole />
      </Suspense>
    </>
  );
}
