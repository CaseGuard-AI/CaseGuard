"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

export function SiteHeader() {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const other = locale === "ur" ? "en" : "ur";

  return (
    <header className="border-b border-zinc-200 dark:border-zinc-800">
      {/* Logical properties (gap, ms-/me-, start/end) keep the layout correct in RTL. */}
      <nav className="mx-auto flex w-full max-w-5xl items-center gap-6 px-4 py-3">
        <Link href="/" className="font-semibold">
          {t("App.name")}
        </Link>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">{t("Nav.research")}</span>
        <span className="text-sm text-zinc-400">{t("Nav.cases")}</span>
        <span className="text-sm text-zinc-400">{t("Nav.drafting")}</span>
        <Link
          href={pathname}
          locale={other}
          lang={other}
          className="ms-auto rounded-md border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
        >
          {t("Nav.switchLanguage")}
        </Link>
      </nav>
    </header>
  );
}
