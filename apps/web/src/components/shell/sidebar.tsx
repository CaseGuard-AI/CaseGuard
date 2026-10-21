"use client";

import { CircleUserRound, PanelLeftClose, PanelLeftOpen, Scale } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Link, usePathname } from "@/i18n/navigation";
import { directionOf, type Locale } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import { activePage, mainNav, settingsNav, type NavItem } from "./nav-items";

type SidebarProps = {
  collapsed?: boolean;
  // Absent in the mobile sheet, which is always expanded.
  onToggle?: () => void;
  onNavigate?: () => void;
};

// The navy sidebar from the prototype. Logical properties only, so it sits on the right in Urdu.
export function Sidebar({ collapsed = false, onToggle, onNavigate }: SidebarProps) {
  const t = useTranslations();
  const active = activePage(usePathname());

  return (
    <div className="flex h-full flex-col bg-navy text-primary-foreground">
      <div className="flex h-16 items-center border-b border-primary-foreground/10 px-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground text-navy">
          <Scale className="size-5" />
        </div>
        {!collapsed && (
          <div className="ms-3 min-w-0">
            <div className="truncate text-sm font-bold">{t("App.name")}</div>
            <div className="truncate text-[9px] text-primary-foreground/55 uppercase">
              {t("App.motto")}
            </div>
          </div>
        )}
        {onToggle && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t(collapsed ? "Nav.expand" : "Nav.collapse")}
            aria-expanded={!collapsed}
            onClick={onToggle}
            className="ms-auto hidden text-primary-foreground/70 hover:bg-primary-foreground/10 hover:text-primary-foreground lg:inline-flex"
          >
            {collapsed ? (
              <PanelLeftOpen className="rtl:-scale-x-100" />
            ) : (
              <PanelLeftClose className="rtl:-scale-x-100" />
            )}
          </Button>
        )}
      </div>

      <nav aria-label={t("Nav.main")} className="cg-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
        {mainNav.map((item) => (
          <NavLink
            key={item.key}
            item={item}
            active={active === item.key}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="border-t border-primary-foreground/10 p-2">
        <NavLink
          item={settingsNav}
          active={active === settingsNav.key}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
        {/* Placeholder until auth (#12) provides the signed-in user. */}
        <div className="flex h-12 items-center gap-3 px-3 text-primary-foreground/65">
          <CircleUserRound className="size-[17px] shrink-0" />
          {!collapsed && <span className="truncate text-xs font-semibold">{t("Nav.account")}</span>}
        </div>
      </div>
    </div>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const t = useTranslations("Nav");
  const locale = useLocale() as Locale;
  const label = t(item.key);
  const Icon = item.icon;

  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      className={cn(
        "flex h-10 items-center gap-3 rounded-sm px-3 text-[13px] font-medium text-primary-foreground/65 transition-colors hover:bg-primary-foreground/8 hover:text-primary-foreground",
        active &&
          "bg-primary-foreground/12 text-primary-foreground before:-ms-3 before:h-5 before:w-[3px] before:bg-primary-foreground",
      )}
    >
      <Icon className="size-[17px] shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );

  if (!collapsed) return link;
  // Radix tooltip sides are physical, so point away from the sidebar in either direction.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side={directionOf(locale) === "rtl" ? "left" : "right"}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
