import { ComingSoon } from "@/components/shell/coming-soon";
import { pageMetadata } from "@/components/shell/page-metadata";

export const generateMetadata = pageMetadata("evaluation");

export default function EvaluationPage({ params }: PageProps<"/[locale]/evaluation">) {
  return <ComingSoon params={params} page="evaluation" />;
}
