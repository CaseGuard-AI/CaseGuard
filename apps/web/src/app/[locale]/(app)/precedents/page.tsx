import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("precedents");

export default function PrecedentsPage({ params }: PageProps<"/[locale]/precedents">) {
  return <ComingSoon params={params} page="precedents" />;
}
