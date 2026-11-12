import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ replace: nav.replace }) }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const person = (n: number, extra: object = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  email: `user${n}@chambers.pk`,
  name: `User ${n}`,
  role: "lawyer",
  locale: "en",
  aiEnabled: true,
  createdAt: "2026-10-01T09:00:00Z",
  ...extra,
});
const admin = person(1, { name: "Ayesha Khan", role: "admin", locale: "ur" });

const providers = [
  { id: "ollama", name: "Ollama", kind: "local", enabled: true },
  { id: "gemini", name: "Google Gemini", kind: "cloud", enabled: false },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Route = (request: Request, url: URL) => Response | undefined | Promise<Response | undefined>;

const defaults: Route = async (request, url) => {
  const path = url.pathname.replace("/api/v1", "");
  if (path === "/admin/users")
    return url.searchParams.get("cursor") === "page-2"
      ? json({ items: [person(3, { role: "researcher" })], nextCursor: null })
      : json({ items: [admin, person(2)], nextCursor: "page-2" });
  if (path === "/admin/providers") return json({ items: providers });
  const user = path.match(/^\/admin\/users\/(.+)$/);
  if (user && request.method === "PATCH") {
    const found = [admin, person(2), person(3)].find((u) => u.id === user[1]);
    return json({ ...found, ...((await request.clone().json()) as object) });
  }
  const provider = path.match(/^\/admin\/providers\/(.+)$/);
  if (provider && request.method === "PATCH") {
    const found = providers.find((p) => p.id === provider[1]);
    return json({ ...found, ...((await request.clone().json()) as object) });
  }
};

async function renderConsole(
  role: "admin" | "lawyer" | "researcher" = "admin",
  route: Route = () => undefined,
) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    return (await route(request, url)) ?? (await defaults(request, url)) ?? problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { AdminConsole } = await import("@/components/admin/admin-console");
  const { signIn } = await import("@/lib/session");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  signIn({ accessToken: "t", expiresIn: 900, user: { ...admin, role } as never });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="ur" messages={ur} timeZone="Asia/Karachi">
        <AdminConsole />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const adminCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .map(([r]) => r as Request)
    .filter((r) => new URL(r.url).pathname.startsWith("/api/v1/admin"));
const aiSwitch = (name: string) =>
  screen.getByRole("switch", { name: ur.Admin.users.aiFor.replace("{name}", name) });
const providerSwitch = (name: string) =>
  screen.getByRole("switch", { name: ur.Admin.providers.enabledFor.replace("{name}", name) });

beforeEach(() => {
  nav.replace.mockReset();
  nav.search = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminConsole access", () => {
  it.each(["lawyer", "researcher"] as const)(
    "shows a %s the forbidden panel and makes no admin request",
    async (role) => {
      const fetchMock = await renderConsole(role);
      expect(screen.getByRole("alert").textContent).toContain(ur.Admin.forbidden);
      await new Promise((r) => setTimeout(r, 20));
      expect(adminCalls(fetchMock)).toHaveLength(0);
    },
  );

  it("shows the forbidden panel when the API answers 403", async () => {
    await renderConsole("admin", (_, url) =>
      url.pathname.endsWith("/admin/users") ? problem(403) : undefined,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(ur.Admin.forbidden);
  });
});

describe("Users tab", () => {
  it("lists users 50 at a time, marks you, and loads more by cursor", async () => {
    const fetchMock = await renderConsole();
    await screen.findByText("User 2");
    expect(new URL(adminCalls(fetchMock)[0].url).searchParams.get("limit")).toBe("50");
    const own = screen.getByText("Ayesha Khan").closest("li")!;
    expect(within(own).getByText(ur.Admin.users.you)).toBeTruthy();
    expect(screen.getByText("User 2").closest("li")!.textContent).not.toContain(ur.Admin.users.you);

    fireEvent.click(screen.getByRole("button", { name: ur.Admin.users.loadMore }));
    await screen.findByText("User 3");
    expect(new URL(adminCalls(fetchMock).at(-1)!.url).searchParams.get("cursor")).toBe("page-2");
    // Each row names the role (FR-AUTH-2).
    expect(within(own).getByText(ur.Nav.roles.admin)).toBeTruthy();
    const row = (name: string) => within(screen.getByText(name).closest("li")!);
    expect(row("User 2").getByText(ur.Nav.roles.lawyer)).toBeTruthy();
    expect(row("User 3").getByText(ur.Nav.roles.researcher)).toBeTruthy();
    expect(screen.queryByRole("button", { name: ur.Admin.users.loadMore })).toBeNull();
  });

  it("turns AI off for a user only once the server confirms", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const fetchMock = await renderConsole("admin", async (request) => {
      if (request.method === "PATCH") await held;
      return undefined;
    });
    await screen.findByText("User 2");
    fireEvent.click(aiSwitch("User 2"));
    await waitFor(() => expect(aiSwitch("User 2").hasAttribute("disabled")).toBe(true));
    expect(aiSwitch("User 2").getAttribute("aria-checked")).toBe("true");
    act(() => release());
    await waitFor(() => expect(aiSwitch("User 2").getAttribute("aria-checked")).toBe("false"));
    const patch = adminCalls(fetchMock).find((r) => r.method === "PATCH")!;
    expect(new URL(patch.url).pathname).toBe(`/api/v1/admin/users/${person(2).id}`);
    expect(await patch.clone().json()).toEqual({ aiEnabled: false });
  });

  it("keeps the switch and explains when the change fails", async () => {
    await renderConsole("admin", (request) =>
      request.method === "PATCH" ? problem(500) : undefined,
    );
    await screen.findByText("User 2");
    fireEvent.click(aiSwitch("User 2"));
    const row = screen.getByText("User 2").closest("li")!;
    expect((await within(row).findByRole("alert")).textContent).toBe(ur.Admin.errors.generic);
    expect(aiSwitch("User 2").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Providers tab", () => {
  beforeEach(() => {
    nav.search = "tab=providers";
  });

  it("opens from ?tab=providers and labels local and cloud", async () => {
    await renderConsole();
    const gemini = (await screen.findByText("Google Gemini")).closest("li")!;
    expect(within(gemini).getByText(ur.Admin.providers.cloud)).toBeTruthy();
    const ollama = screen.getByText("Ollama").closest("li")!;
    expect(within(ollama).getByText(ur.Admin.providers.local)).toBeTruthy();
  });

  it("asks before turning on a cloud provider", async () => {
    const fetchMock = await renderConsole();
    await screen.findByText("Google Gemini");
    fireEvent.click(providerSwitch("Google Gemini"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Google Gemini");
    fireEvent.click(within(dialog).getByRole("button", { name: ur.Admin.providers.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(adminCalls(fetchMock).filter((r) => r.method === "PATCH")).toHaveLength(0);

    fireEvent.click(providerSwitch("Google Gemini"));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: ur.Admin.providers.confirm,
      }),
    );
    await waitFor(() =>
      expect(providerSwitch("Google Gemini").getAttribute("aria-checked")).toBe("true"),
    );
    const patch = adminCalls(fetchMock).find((r) => r.method === "PATCH")!;
    expect(new URL(patch.url).pathname).toBe("/api/v1/admin/providers/gemini");
    expect(await patch.clone().json()).toEqual({ enabled: true });
  });

  it("turns a provider off without asking", async () => {
    const fetchMock = await renderConsole();
    await screen.findByText("Ollama");
    fireEvent.click(providerSwitch("Ollama"));
    await waitFor(() =>
      expect(providerSwitch("Ollama").getAttribute("aria-checked")).toBe("false"),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(adminCalls(fetchMock).filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("warns when no provider is turned on", async () => {
    await renderConsole("admin", (_, url) =>
      url.pathname.endsWith("/admin/providers")
        ? json({ items: providers.map((p) => ({ ...p, enabled: false })) })
        : undefined,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(ur.Admin.providers.noneEnabled);
  });
});
