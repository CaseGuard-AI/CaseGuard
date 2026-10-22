import type { Schemas } from "./api";

// The light/dark theme (FR-SET-1). The account holds the choice, but it arrives only after the
// session is restored, so the last choice is also cached on the device: the head script applies it
// before the first paint, and the account's value replaces it once it loads.
//
// The resolved theme goes on <html> as `data-theme`, not a class. React owns `className` there and
// would drop a script-added class when the locale layout re-renders.

export type Theme = Schemas["Theme"];

export const THEME_KEY = "cg-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

let systemQuery: MediaQueryList | undefined;

function paint(dark: boolean) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

const followSystem = (event: MediaQueryListEvent) => paint(event.matches);

export function applyTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked. The theme still applies for this page.
  }
  systemQuery?.removeEventListener("change", followSystem);
  systemQuery = undefined;
  if (theme === "system") {
    systemQuery = window.matchMedia(DARK_QUERY);
    systemQuery.addEventListener("change", followSystem);
    paint(systemQuery.matches);
  } else {
    paint(theme === "dark");
  }
}

/** Runs in <head> before the first paint. Without a cached choice, it follows the device. */
export const themeScript = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");var d=t==="dark"||(t!=="light"&&matchMedia("${DARK_QUERY}").matches);document.documentElement.dataset.theme=d?"dark":"light"}catch(e){}})()`;
