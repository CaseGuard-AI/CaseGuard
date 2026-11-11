import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/shell/app-shell";
import { activePage } from "@/components/shell/nav-items";
import { directionOf, type Locale } from "@/i18n/routing";
import { getSnapshot, signIn, signOut } from "@/lib/session";
import en from "../messages/en.json";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ pathname: "/", replace: vi.fn() }));
// Installed before the imports: openapi-fetch keeps the fetch it finds when the client is created.
const fetchMock = vi.hoisted(() => {
  const mock = vi.fn<typeof fetch>();
  globalThis.fetch = mock;
  return mock;
});

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ replace: nav.replace }),
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
  nav.replace.mockReset();
  // Session restore and sign-out: no API here, so the cookie is "rejected".
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ type: "about:blank", title: "x", status: 401 }), {
        status: 401,
        headers: { "Content-Type": "application/problem+json" },
      }),
  );
});
afterEach(async () => {
  cleanup();
  await signOut();
  fetchMock.mockReset();
});

const ayesha = {
  accessToken: "t",
  expiresIn: 900,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "ayesha@chambers.pk",
    name: "Ayesha Khan",
    role: "admin" as const,
    locale: "ur" as const,
    aiEnabled: true,
  },
};

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

describe("AppShell with a signed-in user", () => {
  it("shows the user's name, initials and role", () => {
    renderShell("ur", ur);
    act(() => signIn(ayesha));
    expect(screen.getAllByText("Ayesha Khan").length).toBeGreaterThan(0);
    expect(screen.getAllByText("AK").length).toBeGreaterThan(0);
    expect(screen.getByText(ur.Nav.roles.admin)).toBeTruthy();
  });

  it("links the admin console for an Admin only", () => {
    renderShell("ur", ur);
    expect(screen.queryByRole("link", { name: ur.Nav.admin })).toBeNull();
    act(() => signIn(ayesha));
    expect(screen.getByRole("link", { name: ur.Nav.admin }).getAttribute("href")).toBe("/admin");
    act(() => signIn({ ...ayesha, user: { ...ayesha.user, role: "researcher" } }));
    expect(screen.queryByRole("link", { name: ur.Nav.admin })).toBeNull();
    act(() => signIn({ ...ayesha, user: { ...ayesha.user, role: "lawyer" } }));
    expect(screen.queryByRole("link", { name: ur.Nav.admin })).toBeNull();
  });

  it("saves the language to the account before switching", async () => {
    nav.pathname = "/research";
    renderShell("ur", ur);
    act(() => signIn(ayesha));
    const order: string[] = [];
    fetchMock.mockImplementation(async (input) => {
      const request = input as Request;
      order.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response(JSON.stringify({ name: "Ayesha Khan", locale: "en", theme: "system" }), {
        headers: { "Content-Type": "application/json" },
      });
    });
    nav.replace.mockImplementation(() => order.push("navigate"));
    fireEvent.click(screen.getByRole("link", { name: ur.Nav.switchLanguage }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/research", { locale: "en" }));
    expect(order).toEqual(["PATCH /api/v1/me/settings", "navigate"]);
    const patch = fetchMock.mock.calls.find(([r]) => (r as Request).method === "PATCH")!;
    expect(await (patch[0] as Request).json()).toEqual({ locale: "en" });
  });

  it("still switches the language when the save fails", async () => {
    renderShell("en", en);
    act(() => signIn(ayesha));
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("link", { name: en.Nav.switchLanguage }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/", { locale: "ur" }));
  });

  it("signs out from the account menu", async () => {
    renderShell("en", en);
    act(() => signIn(ayesha));
    fireEvent.keyDown(screen.getByRole("button", { name: en.Nav.account }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: en.Nav.signOut }));
    await waitFor(() => expect(getSnapshot().status).toBe("anonymous"));
    const paths = fetchMock.mock.calls.map(
      ([request]) => new URL((request as Request).url).pathname,
    );
    expect(paths).toContain("/api/v1/auth/logout");
  });
});

describe("activePage", () => {
  it("maps pathnames to screens", () => {
    expect(activePage("/")).toBe("dashboard");
    expect(activePage("/stress-test")).toBe("stressTest");
    expect(activePage("/case/42")).toBe("cases");
    expect(activePage("/cases/new")).toBe("cases");
    expect(activePage("/admin")).toBe("admin");
    expect(activePage("/nowhere")).toBeUndefined();
  });
});
