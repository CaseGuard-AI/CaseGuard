"use client";

import { useLocale, useTranslations } from "next-intl";
import type { MouseEvent } from "react";
import { useSession } from "@/components/auth/session-provider";
import { markLocaleApplied } from "@/components/settings/account-preferences";
import { useUpdateSettings } from "@/components/settings/queries";
import { Button } from "@/components/ui/button";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Same page in the other locale. The label is written in that language, so it is always readable.
// Signed in, the choice is also saved to the account (FR-I18N-1). The save finishes before the
// page moves, so a settings load on the new page can't bring back the old locale.
export function LanguageSwitch({ className }: { className?: string }) {
  const t = useTranslations("Nav");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const signedIn = useSession().status === "authenticated";
  const update = useUpdateSettings();
  const other = locale === "ur" ? "en" : "ur";

  const onClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (!signedIn) return;
    event.preventDefault();
    markLocaleApplied();
    // Best effort: the page switches even if the save fails.
    await update.mutateAsync({ locale: other }).catch(() => undefined);
    router.replace(`${pathname}${window.location.search}`, { locale: other });
  };

  return (
    <Button asChild variant="outline" size="sm" className={cn(className)}>
      <Link
        href={pathname}
        locale={other}
        lang={other}
        onClick={(event) => void onClick(event)}
        aria-busy={update.isPending || undefined}
      >
        {t("switchLanguage")}
      </Link>
    </Button>
  );
}
