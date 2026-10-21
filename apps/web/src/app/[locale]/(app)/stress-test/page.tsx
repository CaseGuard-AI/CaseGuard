import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("stressTest");

export default function StressTestPage({ params }: PageProps<"/[locale]/stress-test">) {
  return <ComingSoon params={params} page="stressTest" />;
}
