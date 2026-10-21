"use client";

import {
  ChevronDown,
  ChevronRight,
  CircleUserRound,
  HelpCircle,
  LogOut,
  Menu,
  Search,
  Settings,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useSession } from "@/components/auth/session-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Link, usePathname } from "@/i18n/navigation";
import { signOut } from "@/lib/session";
import { initials } from "./initials";
import { LanguageSwitch } from "./language-switch";
import { activePage } from "./nav-items";

export function AppHeader({ onMenu }: { onMenu: () => void }) {
  const t = useTranslations();
  const page = activePage(usePathname());
  const session = useSession();
  const user = session.status === "authenticated" ? session.user : undefined;

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

      <LanguageSwitch className="ms-auto md:ms-0" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-10 px-2" aria-label={t("Nav.account")}>
            <span className="flex size-7 items-center justify-center rounded-full bg-navy text-[10px] font-bold text-primary-foreground">
              {user ? initials(user.name) : <CircleUserRound className="size-4" />}
            </span>
            {user && (
              <span className="hidden max-w-40 truncate text-xs sm:inline">{user.name}</span>
            )}
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {user && (
            <>
              <DropdownMenuLabel>
                <div className="truncate">{user.name}</div>
                <div className="truncate text-xs font-normal text-muted-foreground" dir="ltr">
                  {user.email}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
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
          <DropdownMenuSeparator />
          {/* The session guard then sends this tab (and the others) to the login page. */}
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut className="rtl:-scale-x-100" />
            {t("Nav.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
