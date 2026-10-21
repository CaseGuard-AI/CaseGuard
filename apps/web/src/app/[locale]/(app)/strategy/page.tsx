import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("strategy");

export default function StrategyPage({ params }: PageProps<"/[locale]/strategy">) {
  return <ComingSoon params={params} page="strategy" />;
}
