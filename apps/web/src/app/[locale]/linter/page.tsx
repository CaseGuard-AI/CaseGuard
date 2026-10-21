import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("linter");

export default function LinterPage({ params }: PageProps<"/[locale]/linter">) {
  return <ComingSoon params={params} page="linter" />;
}
