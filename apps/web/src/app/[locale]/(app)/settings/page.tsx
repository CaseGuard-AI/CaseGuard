import { ComingSoon, pageMetadata } from "@/components/shell/coming-soon";

export const generateMetadata = pageMetadata("settings");

export default function SettingsPage({ params }: PageProps<"/[locale]/settings">) {
  return <ComingSoon params={params} page="settings" />;
}
