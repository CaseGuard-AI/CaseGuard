"use client";

import { themeScript } from "@/lib/theme";

// Applies the cached theme before the first paint (FR-SET-1, #115). The server HTML carries an
// executable script. When the browser renders it fresh (switching locale re-renders the root
// layout), React 19 warns about any executable <script>, and the copy would never run anyway, so the
// client renders it as a text/plain data block. suppressHydrationWarning covers the `type` mismatch
// while hydrating, and applyTheme keeps the theme after that.
export function ThemeScript() {
  return (
    <script
      suppressHydrationWarning
      type={typeof window === "undefined" ? undefined : "text/plain"}
      dangerouslySetInnerHTML={{ __html: themeScript }}
    />
  );
}
