"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  HelpCircle,
  Menu,
  Search,
  Settings,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Link, usePathname } from "@/i18n/navigation";
import { activePage } from "./nav-items";

export function AppHeader({ onMenu }: { onMenu: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const page = activePage(pathname);
  const other = locale === "ur" ? "en" : "ur";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-card/95 px-4 backdrop-blur sm:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label={t("Nav.openMenu")}
        onClick={onMenu}
      >
        <Menu />
      </Button>

      <nav
        aria-label={t("Nav.breadcrumb")}
        className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex"
      >
        <span>{t("App.name")}</span>
        {page && (
          <>
            <ChevronRight className="size-3 rtl:rotate-180" />
            <span className="font-medium text-foreground">{t(`Nav.${page}`)}</span>
          </>
        )}
      </nav>

      {/* Visual only until global search exists. */}
      <div className="ms-auto hidden w-full max-w-sm md:block">
        <div className="relative">
          <Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            disabled
            aria-label={t("Nav.search")}
            placeholder={t("Nav.search")}
            className="h-9 bg-muted/60 ps-9"
          />
        </div>
      </div>

      <Button asChild variant="outline" size="sm" className="ms-auto md:ms-0">
        <Link href={pathname} locale={other} lang={other}>
          {t("Nav.switchLanguage")}
        </Link>
      </Button>

      {/* Placeholder until auth (#12) provides the signed-in user and sign-out. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-10 px-2" aria-label={t("Nav.account")}>
            <span className="flex size-7 items-center justify-center rounded-full bg-navy text-primary-foreground">
              <CircleUserRound className="size-4" />
            </span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <CircleUserRound />
              {t("Nav.profile")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/settings">
              <Settings />
              {t("Nav.settings")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem disabled>
            <HelpCircle />
            {t("Nav.help")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
