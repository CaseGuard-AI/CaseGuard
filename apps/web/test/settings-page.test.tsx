import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), pathname: "/settings" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => nav.pathname,
}));

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ayesha@chambers.pk",
  name: "Ayesha Khan",
  role: "lawyer",
  locale: "en",
  aiEnabled: true,
};
const saved = { name: "Ayesha Khan", locale: "en", theme: "light", defaultModel: null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Route = (
  request: Request,
  path: string,
) => Response | undefined | Promise<Response | undefined>;

// The settings API: GET returns the saved values, PATCH merges the body into them. No model
// providers are enabled here; test/settings-keys.test.tsx covers the Models & keys section.
const defaults: Route = async (request, path) => {
  if (path === "/models" || path === "/me/keys") return json([]);
  if (path !== "/me/settings") return;
  if (request.method === "GET") return json(saved);
  if (request.method === "PATCH")
    return json({ ...saved, ...((await request.clone().json()) as object) });
};

async function renderSettings(route: Route = () => undefined) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname.replace("/api/v1", "");
    return (await route(request, path)) ?? (await defaults(request, path)) ?? problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { SettingsForm } = await import("@/components/settings/settings-form");
  const { AccountPreferences } = await import("@/components/settings/account-preferences");
  const session = await import("@/lib/session");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  session.signIn({ accessToken: "t", expiresIn: 900, user: user as never });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Karachi">
        <AccountPreferences />
        <SettingsForm />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  const patches = () =>
    Promise.all(
      fetchMock.mock.calls
        .map(([request]) => request as Request)
        .filter((request) => request.method === "PATCH")
        .map((request) => request.clone().json()),
    );
  return { fetchMock, patches, session };
}

const nameInput = () => screen.findByLabelText(en.Settings.profile.name);
const saveButton = () => screen.getByRole("button", { name: en.Settings.profile.save });

beforeEach(() => {
  nav.replace.mockReset();
  localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings page", () => {
  it("shows the saved name, email, language and theme", async () => {
    await renderSettings();
    expect(((await nameInput()) as HTMLInputElement).value).toBe("Ayesha Khan");
    expect((screen.getByLabelText(en.Settings.profile.email) as HTMLInputElement).value).toBe(
      user.email,
    );
    expect((screen.getByRole("radio", { name: "English" }) as HTMLInputElement).checked).toBe(true);
    expect(
      (screen.getByRole("radio", { name: en.Settings.theme.light }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("saves a trimmed name and updates the session's user", async () => {
    const { patches, session } = await renderSettings();
    fireEvent.change(await nameInput(), { target: { value: "  Ayesha K. Malik  " } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole("status")).toHaveProperty("textContent", en.Settings.saved);
    expect(await patches()).toEqual([{ name: "Ayesha K. Malik" }]);
    const state = session.getSnapshot();
    expect(state.status === "authenticated" && state.user.name).toBe("Ayesha K. Malik");
  });

  it("blocks an empty or too-long name without calling the API", async () => {
    const { patches } = await renderSettings();
    fireEvent.change(await nameInput(), { target: { value: "   " } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(en.Settings.profile.errors.required)).toBeTruthy();
    fireEvent.change(await nameInput(), { target: { value: "x".repeat(121) } });
    fireEvent.click(saveButton());
    expect(await screen.findByText("Use 120 characters or fewer.")).toBeTruthy();
    expect(await patches()).toEqual([]);
  });

  it("shows a 400 from the API on the name field", async () => {
    await renderSettings((request) => (request.method === "PATCH" ? problem(400) : undefined));
    fireEvent.change(await nameInput(), { target: { value: "New name" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(en.Settings.errors.invalid)).toBeTruthy();
    expect((await nameInput()).getAttribute("aria-invalid")).toBe("true");
  });

  it("saves the theme and then applies it", async () => {
    const { patches } = await renderSettings();
    await nameInput();
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.click(screen.getByRole("radio", { name: en.Settings.theme.dark }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    expect(localStorage.getItem("cg-theme")).toBe("dark");
    expect(await patches()).toEqual([{ theme: "dark" }]);
  });

  it("keeps the old theme when the save fails", async () => {
    await renderSettings((request) => (request.method === "PATCH" ? problem(500) : undefined));
    await nameInput();
    fireEvent.click(screen.getByRole("radio", { name: en.Settings.theme.dark }));
    expect(await screen.findByText(en.Settings.errors.generic)).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(
      (screen.getByRole("radio", { name: en.Settings.theme.light }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("saves the language, then moves the page to it", async () => {
    const { patches } = await renderSettings();
    await nameInput();
    fireEvent.click(screen.getByRole("radio", { name: "اردو" }));
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/settings", { locale: "ur" }));
    expect(await patches()).toEqual([{ locale: "ur" }]);
  });

  it("offers a retry when the settings can't be loaded", async () => {
    let offline = true;
    await renderSettings(() => {
      if (offline) throw new TypeError("Failed to fetch");
      return undefined;
    });
    expect(await screen.findByText(en.Settings.errors.network)).toBeTruthy();
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: en.Settings.retry }));
    expect(await nameInput()).toBeTruthy();
  });
});
