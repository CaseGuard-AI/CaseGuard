import { Suspense } from "react";
import { RequireSession } from "@/components/auth/require-session";
import { AccountPreferences } from "@/components/settings/account-preferences";
import { AppShell } from "@/components/shell/app-shell";

// Every screen in the app needs a session; signed-out visitors go to the login page. Once signed
// in, the account's saved theme and language apply.
// The shell reads the pathname, which is request data on a route with an id in it
// (`/cases/[caseId]`), so it sits in a Suspense boundary. On every other route the pathname is
// known at build time and the boundary never suspends.
export default function AppLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <Suspense>
      <RequireSession>
        <AccountPreferences />
        <AppShell>{children}</AppShell>
      </RequireSession>
    </Suspense>
  );
}
