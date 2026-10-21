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

export type NavItem = { key: PageKey; href: string; icon: LucideIcon };

// Order and icons follow the prototype (CaseGuard-AI/high_level_design).
export const mainNav: NavItem[] = [
  { key: "dashboard", href: "/", icon: LayoutDashboard },
  { key: "cases", href: "/cases", icon: BriefcaseBusiness },
  { key: "research", href: "/research", icon: Search },
  { key: "precedents", href: "/precedents", icon: Network },
  { key: "strategy", href: "/strategy", icon: Sparkles },
  { key: "drafting", href: "/drafting", icon: FileText },
  { key: "linter", href: "/linter", icon: FileCheck2 },
  { key: "stressTest", href: "/stress-test", icon: MessageSquareWarning },
  { key: "documents", href: "/documents", icon: FolderOpen },
  { key: "evaluation", href: "/evaluation", icon: Activity },
];

export const settingsNav: NavItem = { key: "settings", href: "/settings", icon: Settings };

// Shown only to Admins (FR-AUTH-2). The API checks the role on every /admin call regardless.
export const adminNav: NavItem = { key: "admin", href: "/admin", icon: ShieldCheck };

// The screen a locale-less pathname belongs to. A single case (`/case/...`) counts as Cases.
export function activePage(pathname: string): PageKey | undefined {
  if (pathname === "/case" || pathname.startsWith("/case/")) return "cases";
  return [...mainNav, settingsNav, adminNav].find(
    ({ href }) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)),
  )?.key;
}
