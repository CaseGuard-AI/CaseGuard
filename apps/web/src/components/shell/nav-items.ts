import {
  Activity,
  BriefcaseBusiness,
  FileCheck2,
  FileText,
  FolderOpen,
  LayoutDashboard,
  MessageSquareWarning,
  Network,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

// One key per screen. Labels live in messages under `Nav.<key>` and `Pages.<key>`.
export type PageKey =
  | "dashboard"
  | "cases"
  | "research"
  | "precedents"
  | "strategy"
  | "drafting"
  | "linter"
  | "stressTest"
  | "documents"
  | "evaluation"
  | "settings"
  | "admin";

// `soon` marks a screen that is still a placeholder: the sidebar gives it a "Soon" badge.
export type NavItem = { key: PageKey; href: string; icon: LucideIcon; soon?: boolean };

// Order and icons follow the prototype (CaseGuard-AI/high_level_design).
export const mainNav: NavItem[] = [
  { key: "dashboard", href: "/", icon: LayoutDashboard },
  { key: "cases", href: "/cases", icon: BriefcaseBusiness },
  { key: "research", href: "/research", icon: Search },
  { key: "precedents", href: "/precedents", icon: Network },
  { key: "strategy", href: "/strategy", icon: Sparkles, soon: true },
  { key: "drafting", href: "/drafting", icon: FileText },
  { key: "linter", href: "/linter", icon: FileCheck2 },
  { key: "stressTest", href: "/stress-test", icon: MessageSquareWarning, soon: true },
  { key: "documents", href: "/documents", icon: FolderOpen },
];

export const settingsNav: NavItem = { key: "settings", href: "/settings", icon: Settings };

// Shown only to Admins (FR-AUTH-2; evaluation is an admin screen, FR-EVAL-3). The API checks the
// role on every admin call regardless.
export const adminNav: NavItem[] = [
  { key: "admin", href: "/admin", icon: ShieldCheck },
  { key: "evaluation", href: "/evaluation", icon: Activity, soon: true },
];

// The screen a locale-less pathname belongs to.
export function activePage(pathname: string): PageKey | undefined {
  return [...mainNav, settingsNav, ...adminNav].find(
    ({ href }) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)),
  )?.key;
}
