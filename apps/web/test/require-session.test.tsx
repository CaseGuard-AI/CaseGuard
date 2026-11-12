import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const nav = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => "/research",
  useRouter: () => ({ replace: nav.replace }),
}));

const problem = (status: number) =>
  new Response(JSON.stringify({ type: "about:blank", title: "x", status }), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });

async function renderGuard(response: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => response()),
  );
  vi.resetModules();
  const session = await import("@/lib/session");
  const { RequireSession } = await import("@/components/auth/require-session");
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RequireSession>
        <p>secret page</p>
      </RequireSession>
    </NextIntlClientProvider>,
  );
  return session;
}

beforeEach(() => nav.replace.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RequireSession", () => {
  it("shows a busy state while the session is restored", async () => {
    await renderGuard(() => problem(401));
    expect(screen.getByText(en.Auth.session.checking).getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("secret page")).toBeNull();
  });

  it("sends a signed-out visitor to the login page, remembering the page", async () => {
    const session = await renderGuard(() => problem(401));
    await act(() => session.refresh());
    expect(nav.replace).toHaveBeenCalledWith("/login?next=%2Fresearch");
    expect(screen.queryByText("secret page")).toBeNull();
  });

  it("offers a retry instead of signing out when the API is unavailable", async () => {
    const session = await renderGuard(() => problem(429));
    await act(() => session.refresh());
    expect(screen.getByRole("alert").textContent).toContain(en.Auth.session.unavailable);
    expect(screen.getByRole("button", { name: en.Auth.session.retry })).toBeTruthy();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("renders the page once signed in", async () => {
    const session = await renderGuard(() => problem(401));
    act(() =>
      session.signIn({
        accessToken: "t",
        expiresIn: 900,
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          email: "ayesha@chambers.pk",
          name: "Ayesha Khan",
          role: "lawyer",
          locale: "en",
          aiEnabled: false,
        },
      }),
    );
    expect(screen.getByText("secret page")).toBeTruthy();
  });
});
