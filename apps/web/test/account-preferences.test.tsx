import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: "/research" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.pathname,
}));

const session = {
  accessToken: "t",
  expiresIn: 900,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    email: "ayesha@chambers.pk",
    name: "Ayesha Khan",
    role: "lawyer" as const,
    locale: "ur" as const,
    aiEnabled: true,
  },
};
let saved = { name: "Ayesha Khan", locale: "ur", theme: "dark" };

async function setup() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL((input as Request).url).pathname;
      return path.endsWith("/me/settings")
        ? new Response(JSON.stringify(saved), { headers: { "Content-Type": "application/json" } })
        : new Response(null, { status: 204 });
    }),
  );
  vi.resetModules();
  const preferences = await import("@/components/settings/account-preferences");
  const store = await import("@/lib/session");
  // A fresh cache per mount, as after a locale switch remounts the providers.
  const mount = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <NextIntlClientProvider locale="en" messages={en}>
          <preferences.AccountPreferences />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  return { ...preferences, store, mount };
}

beforeEach(() => {
  nav.replace.mockReset();
  sessionStorage.clear();
  // Each test waits for the theme to land, which happens in the same commit as the locale check.
  delete document.documentElement.dataset.theme;
  saved = { name: "Ayesha Khan", locale: "ur", theme: "dark" };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AccountPreferences", () => {
  it("applies the saved theme and moves to the saved locale once", async () => {
    const { store, mount } = await setup();
    store.signIn(session);
    mount();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/research", { locale: "ur" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    // A remount in the same session (the locale switch re-renders the layout) doesn't redirect again.
    cleanup();
    delete document.documentElement.dataset.theme;
    mount();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it("leaves a reloaded or typed URL alone in the same tab", async () => {
    const first = await setup();
    first.store.signIn(session);
    first.mount();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    cleanup();
    delete document.documentElement.dataset.theme;
    // A full load: fresh modules, but the tab's sessionStorage remains.
    const reloaded = await setup();
    reloaded.store.signIn(session);
    reloaded.mount();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it("leaves the page alone when it's already in the saved locale", async () => {
    saved = { ...saved, locale: "en" };
    const { store, mount } = await setup();
    store.signIn(session);
    mount();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("doesn't undo a locale the user just picked in the header", async () => {
    const { store, mount, markLocaleApplied } = await setup();
    store.signIn(session);
    markLocaleApplied();
    mount();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("applies the saved locale again after signing out and back in", async () => {
    const { store, mount } = await setup();
    store.signIn(session);
    mount();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(1));
    cleanup();
    await act(() => store.signOut());
    store.signIn(session);
    mount();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledTimes(2));
  });
});
