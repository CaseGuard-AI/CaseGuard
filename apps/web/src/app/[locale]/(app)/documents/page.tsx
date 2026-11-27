import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { DocumentsList } from "@/components/documents/documents-list";
import { pageMetadata } from "@/components/shell/page-metadata";
import { PageIntro } from "@/components/shell/page-intro";
import { Link } from "@/i18n/navigation";

export const generateMetadata = pageMetadata("documents");

// All of the user's documents with their processing status (FR-DOC-3). Uploads happen on a case's
// dashboard, since every document belongs to a case.
export default function DocumentsPage({ params }: PageProps<"/[locale]/documents">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro title={t("Pages.documents.title")} subtitle={t("Pages.documents.subtitle")} />
      <p className="mb-4 text-sm text-muted-foreground">
        {t("Documents.list.uploadHint")}{" "}
        <Link href="/cases" className="font-medium text-primary underline-offset-2 hover:underline">
          {t("Documents.list.goToCases")}
        </Link>
      </p>
      <DocumentsList showCase />
    </>
  );
}
