import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Suspense, use } from "react";
import { DraftsList } from "@/components/drafting/drafts-list";
import { NewDraft } from "@/components/drafting/new-draft";
import { pageMetadata } from "@/components/shell/coming-soon";
import { PageIntro } from "@/components/shell/page-intro";

export const generateMetadata = pageMetadata("drafting");

// The drafting studio (FR-DRAFT-1, FR-DRAFT-2): start a draft from a template, optionally from a
// case, and reopen earlier drafts.
export default function DraftingPage({ params }: PageProps<"/[locale]/drafting">) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations();

  return (
    <>
      <PageIntro title={t("Pages.drafting.title")} subtitle={t("Pages.drafting.subtitle")} />
      <div className="space-y-6">
        {/* The form reads `?case=`, which needs a Suspense boundary for static rendering. */}
        <Suspense>
          <NewDraft />
        </Suspense>
        <section>
          <h2 className="mb-3 text-base font-semibold">{t("Drafting.list.title")}</h2>
          <DraftsList showCase />
        </section>
      </div>
    </>
  );
}
