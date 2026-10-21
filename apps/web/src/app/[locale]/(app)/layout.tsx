import { RequireSession } from "@/components/auth/require-session";
import { AppShell } from "@/components/shell/app-shell";

// Every screen in the app needs a session; signed-out visitors go to the login page.
export default function AppLayout({ children }: LayoutProps<"/[locale]">) {
  return (
    <RequireSession>
      <AppShell>{children}</AppShell>
    </RequireSession>
  );
}
