import { setRequestLocale } from "next-intl/server";
import { Suspense, use } from "react";
import { DraftEditor } from "@/components/drafting/draft-editor";
import { pageMetadata } from "@/components/shell/page-metadata";

export const generateMetadata = pageMetadata("drafting");

// One draft in the editor (FR-DRAFT-3, FR-DRAFT-4). The id is request data, so the client part
// sits in a Suspense boundary.
export default function DraftPage({ params }: PageProps<"/[locale]/drafting/[draftId]">) {
  const { locale, draftId } = use(params);
  setRequestLocale(locale);
  return (
    <Suspense>
      <DraftEditor draftId={draftId} />
    </Suspense>
  );
}
