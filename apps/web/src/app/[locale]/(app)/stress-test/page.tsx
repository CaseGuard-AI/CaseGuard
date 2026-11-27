import { ComingSoon } from "@/components/shell/coming-soon";
import { pageMetadata } from "@/components/shell/page-metadata";

export const generateMetadata = pageMetadata("stressTest");

export default function StressTestPage({ params }: PageProps<"/[locale]/stress-test">) {
  return <ComingSoon params={params} page="stressTest" />;
}
