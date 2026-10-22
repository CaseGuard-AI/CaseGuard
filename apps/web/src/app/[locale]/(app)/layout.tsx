import { RequireSession } from "@/components/auth/require-session";
import { AccountPreferences } from "@/components/settings/account-preferences";
import { AppShell } from "@/components/shell/app-shell";

// Every screen in the app needs a session; signed-out visitors go to the login page. Once signed
// in, the account's saved theme and language apply.
export default function AppLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <RequireSession>
      <AccountPreferences />
      <AppShell>{children}</AppShell>
    </RequireSession>
  );
}
