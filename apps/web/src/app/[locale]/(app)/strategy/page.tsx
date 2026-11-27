import { ComingSoon } from "@/components/shell/coming-soon";
import { pageMetadata } from "@/components/shell/page-metadata";

export const generateMetadata = pageMetadata("strategy");

export default function StrategyPage({ params }: PageProps<"/[locale]/strategy">) {
  return <ComingSoon params={params} page="strategy" />;
}
