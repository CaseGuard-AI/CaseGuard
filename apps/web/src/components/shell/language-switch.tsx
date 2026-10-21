"use client";

import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Same page in the other locale. The label is written in that language, so it is always readable.
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useTranslations("Nav");
  const locale = useLocale();
  const pathname = usePathname();
  const other = locale === "ur" ? "en" : "ur";

  return (
    <Button asChild variant="outline" size="sm" className={cn(className)}>
      <Link href={pathname} locale={other} lang={other}>
        {t("switchLanguage")}
      </Link>
    </Button>
  );
}
