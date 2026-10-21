import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("research");

export default function ResearchPage({ params }: PageProps<"/[locale]/research">) {
  return <ComingSoon params={params} page="research" />;
}
