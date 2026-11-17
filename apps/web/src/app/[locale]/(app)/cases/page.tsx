import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { CasesList } from "@/components/cases/cases-list";
import { pageMetadata } from "@/components/shell/coming-soon";
import { PageIntro } from "@/components/shell/page-intro";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export const generateMetadata = pageMetadata("cases");

export default function CasesPage({ params }: PageProps<"/[locale]/cases">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro
        title={t("Pages.cases.title")}
        subtitle={t("Pages.cases.subtitle")}
        actions={
          <Button asChild>
            <Link href="/cases/new">
              <Plus aria-hidden />
              {t("Cases.new")}
            </Link>
          </Button>
        }
      />
      <CasesList />
    </>
  );
}
