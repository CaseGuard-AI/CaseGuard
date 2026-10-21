"use client";

import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { AppHeader } from "./app-header";
import { Sidebar } from "./sidebar";

// The app frame from the prototype: a collapsible sidebar on large screens, a sheet on small ones.
export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations("Nav");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 hidden transition-all lg:block",
          collapsed ? "w-16" : "w-64",
        )}
      >
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} />
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent
          side="start"
          closeLabel={t("closeMenu")}
          className="w-72 gap-0 border-0 p-0 text-primary-foreground sm:max-w-72"
        >
          <SheetTitle className="sr-only">{t("main")}</SheetTitle>
          <Sidebar onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className={cn("transition-all", collapsed ? "lg:ps-16" : "lg:ps-64")}>
        <AppHeader onMenu={() => setMobileOpen(true)} />
        <main className="cg-rise p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
