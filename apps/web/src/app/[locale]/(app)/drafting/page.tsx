import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("drafting");

export default function DraftingPage({ params }: PageProps<"/[locale]/drafting">) {
  return <ComingSoon params={params} page="drafting" />;
}
