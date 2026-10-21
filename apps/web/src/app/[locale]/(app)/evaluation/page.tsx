import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("evaluation");

export default function EvaluationPage({ params }: PageProps<"/[locale]/evaluation">) {
  return <ComingSoon params={params} page="evaluation" />;
}
