"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSession } from "@/components/auth/session-provider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouter } from "@/i18n/navigation";
import { ProvidersPanel } from "./providers-panel";
import { Forbidden } from "./states";
import { UsersPanel } from "./users-panel";

const tabs = ["users", "providers"] as const;
type Tab = (typeof tabs)[number];

// The admin console (#91, FR-AUTH-3). Hiding it from Users is only for the browser: the API
// checks the role on every /admin call, and a 403 from it shows the same panel.
export function AdminConsole() {
  const t = useTranslations("Admin");
  const session = useSession();
  const router = useRouter();
  const requested = useSearchParams().get("tab");
  const tab: Tab = tabs.includes(requested as Tab) ? (requested as Tab) : "users";

  if (session.status !== "authenticated" || session.user.role !== "admin") return <Forbidden />;

  return (
    <Tabs value={tab} onValueChange={(value) => router.replace(`/admin?tab=${value}`)}>
      <TabsList>
        {tabs.map((key) => (
          <TabsTrigger key={key} value={key}>
            {t(`tabs.${key}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="users" className="mt-4">
        <UsersPanel currentUserId={session.user.id} />
      </TabsContent>
      <TabsContent value="providers" className="mt-4">
        <ProvidersPanel />
      </TabsContent>
    </Tabs>
  );
}
