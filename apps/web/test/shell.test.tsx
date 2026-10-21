import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/shell/app-shell";
import { activePage } from "@/components/shell/nav-items";
import { directionOf, type Locale } from "@/i18n/routing";
import en from "../messages/en.json";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ pathname: "/" }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => nav.pathname,
  Link: ({
    href,
    locale,
    children,
    ...props
  }: { href: string; locale?: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} data-locale={locale} {...props}>
      {children}
    </a>
  ),
}));

const navKeys = [
  "dashboard",
  "cases",
  "research",
  "precedents",
  "strategy",
  "drafting",
  "linter",
  "stressTest",
  "documents",
  "evaluation",
] as const;

function renderShell(locale: Locale, messages: typeof en) {
  const dir = directionOf(locale);
  return render(
    <div dir={dir}>
      <NextIntlClientProvider locale={locale} messages={messages}>
        <Providers dir={dir}>
          <AppShell>
            <p>content</p>
          </AppShell>
        </Providers>
      </NextIntlClientProvider>
    </div>,
  );
}

beforeEach(() => {
  nav.pathname = "/";
});
afterEach(cleanup);

describe("AppShell", () => {
  it("renders every nav item from the Urdu messages", () => {
    renderShell("ur", ur);
    const main = screen.getByRole("navigation", { name: ur.Nav.main });
    for (const key of navKeys) {
      expect(within(main).getByRole("link", { name: ur.Nav[key] })).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: ur.Nav.settings })).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("renders the same nav in English", () => {
    renderShell("en", en);
    const main = screen.getByRole("navigation", { name: en.Nav.main });
    expect(
      within(main)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(navKeys.map((key) => en.Nav[key]));
  });

  it("marks the current page and shows it in the breadcrumb", () => {
    nav.pathname = "/research";
    renderShell("en", en);
    const main = screen.getByRole("navigation", { name: en.Nav.main });
    const active = within(main)
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current"));
    expect(active.map((a) => a.textContent)).toEqual([en.Nav.research]);
    const breadcrumb = screen.getByRole("navigation", { name: en.Nav.breadcrumb });
    expect(breadcrumb.textContent).toContain(en.Nav.research);
  });

  it("collapses and expands the sidebar", () => {
    renderShell("ur", ur);
    fireEvent.click(screen.getByRole("button", { name: ur.Nav.collapse }));
    expect(screen.getByRole("button", { name: ur.Nav.expand })).toBeTruthy();
    // Collapsed links keep an accessible name even without visible text.
    const main = screen.getByRole("navigation", { name: ur.Nav.main });
    expect(within(main).getByRole("link", { name: ur.Nav.cases })).toBeTruthy();
  });

  it("links the language switch to the other locale", () => {
    renderShell("ur", ur);
    const link = screen.getByRole("link", { name: ur.Nav.switchLanguage });
    expect(link.dataset.locale).toBe("en");
    expect(link.getAttribute("lang")).toBe("en");
  });
});

describe("activePage", () => {
  it("maps pathnames to screens", () => {
    expect(activePage("/")).toBe("dashboard");
    expect(activePage("/stress-test")).toBe("stressTest");
    expect(activePage("/case/42")).toBe("cases");
    expect(activePage("/cases/new")).toBe("cases");
    expect(activePage("/nowhere")).toBeUndefined();
  });
});
