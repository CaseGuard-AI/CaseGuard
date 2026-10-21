import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("cases");

export default function CasesPage({ params }: PageProps<"/[locale]/cases">) {
  return <ComingSoon params={params} page="cases" />;
}
