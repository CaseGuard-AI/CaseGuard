"use client";

import { useLocale } from "next-intl";
import { useEffect } from "react";
import { usePathname, useRouter } from "@/i18n/navigation";
import { getSnapshot, subscribe } from "@/lib/session";
import { applyTheme } from "@/lib/theme";
import { useSettings } from "./queries";

// The saved locale takes over once per session start (sign-in, or a fresh tab restoring it). After
// that, a typed or shared /en or /ur link is left alone. The flag is per tab and outlives a
// reload or a typed URL (sessionStorage), and a ref wouldn't do: switching locale re-renders the
// [locale] layout and can remount the app shell. Signing out clears it.
const APPLIED_KEY = "cg-locale-applied";
let localeApplied = readApplied();

function readApplied() {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(APPLIED_KEY) === "1";
  } catch {
    return false;
  }
}

function setApplied(applied: boolean) {
  localeApplied = applied;
  try {
    if (applied) sessionStorage.setItem(APPLIED_KEY, "1");
    else sessionStorage.removeItem(APPLIED_KEY);
  } catch {
    // Storage can be blocked; the flag still holds for this page.
  }
}

subscribe(() => {
  if (getSnapshot().status === "anonymous") setApplied(false);
});

/** For the header switch: the user just chose a locale, so the saved one must not undo it. */
export function markLocaleApplied() {
  setApplied(true);
}

/** Applies the signed-in user's saved theme and language (FR-SET-1, FR-I18N-1). Renders nothing. */
export function AccountPreferences() {
  const { data } = useSettings();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (data) applyTheme(data.theme);
  }, [data]);

  useEffect(() => {
    if (!data || localeApplied) return;
    setApplied(true);
    if (data.locale !== locale) {
      router.replace(`${pathname}${window.location.search}`, { locale: data.locale });
    }
  }, [data, locale, pathname, router]);

  return null;
}
