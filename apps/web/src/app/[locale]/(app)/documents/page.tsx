import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("documents");

export default function DocumentsPage({ params }: PageProps<"/[locale]/documents">) {
  return <ComingSoon params={params} page="documents" />;
}
