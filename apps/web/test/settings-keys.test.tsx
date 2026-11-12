import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

// FR-SET-2: the "Models & keys" section of the settings page (ADR-0009).

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/settings",
}));

const m = en.Settings.models;
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "ayesha@chambers.pk",
  name: "Ayesha Khan",
  role: "user",
  locale: "en",
  aiEnabled: true,
};
const TEST_KEY = "sk-test-DO-NOT-LEAK-1234abcd";

type Settings = { name: string; locale: string; theme: string; defaultModel: unknown };
type Key = { providerId: string; last4: string; createdAt: string; updatedAt: string };

let settings: Settings;
let keys: Key[];
const providers = () => [
  {
    providerId: "gemini",
    name: "Google Gemini",
    kind: "cloud",
    models: ["gemini-2.0-flash", "gemini-1.5-pro"],
    hasKey: keys.some((k) => k.providerId === "gemini"),
  },
  { providerId: "ollama", name: "Ollama", kind: "local", models: ["llama3.1:8b"], hasKey: false },
  {
    providerId: "openai",
    name: "OpenAI",
    kind: "cloud",
    models: ["gpt-4o-mini"],
    hasKey: keys.some((k) => k.providerId === "openai"),
  },
];

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

// A small fake of the api: settings, keys and models, with PUT and DELETE changing `keys`.
const defaults: Route = async (request, path) => {
  const body = () => request.clone().json() as Promise<Record<string, unknown>>;
  if (path === "/me/settings") {
    if (request.method === "PATCH") settings = { ...settings, ...(await body()) };
    return json(settings);
  }
  if (path === "/models") return json(providers());
  if (path === "/me/keys") return json(keys);
  const match = /^\/me\/keys\/([^/]+)$/.exec(path);
  if (!match) return;
  const providerId = match[1]!;
  if (request.method === "PUT") {
    const { apiKey } = (await body()) as { apiKey: string };
    const now = "2026-11-12T09:00:00.000Z";
    const saved = { providerId, last4: apiKey.slice(-4), createdAt: now, updatedAt: now };
    keys = [...keys.filter((k) => k.providerId !== providerId), saved];
    return json(saved);
  }
  if (request.method === "DELETE") {
    keys = keys.filter((k) => k.providerId !== providerId);
    return new Response(null, { status: 204 });
  }
};

async function renderSettings(route: Route = () => undefined) {
  // Every request as sent, with its body read before the fake api reads it.
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname.replace("/api/v1", "");
    const text = await request.clone().text();
    requests.push({ method: request.method, path, body: text ? JSON.parse(text) : undefined });
    return (await route(request, path)) ?? (await defaults(request, path)) ?? problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { SettingsForm } = await import("@/components/settings/settings-form");
  const session = await import("@/lib/session");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  session.signIn({ accessToken: "t", expiresIn: 900, user: user as never });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Karachi">
        <SettingsForm />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  const sent = (method: string) =>
    requests.filter((r) => r.method === method).map(({ path, body }) => ({ path, body }));
  return { sent };
}

const keyInput = (name: string) =>
  screen.findByLabelText(m.keyLabel.replace("{name}", name)) as Promise<HTMLInputElement>;
const modelSelect = () => screen.findByLabelText(m.defaultLabel) as Promise<HTMLSelectElement>;
const optionValue = (label: string) =>
  (screen.getByRole("option", { name: label }) as HTMLOptionElement).value;

beforeEach(() => {
  settings = { name: "Ayesha Khan", locale: "en", theme: "light", defaultModel: null };
  keys = [
    {
      providerId: "gemini",
      last4: "x9Qz",
      createdAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
    },
  ];
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Models & keys settings", () => {
  it("lists the enabled providers with the saved key's last four characters", async () => {
    await renderSettings();
    const gemini = await screen.findByRole("listitem", { name: "Google Gemini" });
    expect(within(gemini).getByText("••••x9Qz")).toBeTruthy();
    expect(within(gemini).getByText("Updated Nov 1, 2026")).toBeTruthy();
    expect(within(gemini).getByRole("button", { name: m.replace })).toBeTruthy();

    const openai = screen.getByRole("listitem", { name: "OpenAI" });
    expect(within(openai).getByText(m.noKey)).toBeTruthy();
    const input = await keyInput("OpenAI");
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");

    const ollama = screen.getByRole("listitem", { name: "Ollama" });
    expect(within(ollama).getByText(m.noKeyNeeded)).toBeTruthy();
    expect(within(ollama).queryByRole("textbox")).toBeNull();
    expect(screen.queryByLabelText(m.keyLabel.replace("{name}", "Ollama"))).toBeNull();
  });

  it("saves a key with PUT, clears the input and never shows the key again", async () => {
    const { sent } = await renderSettings();
    const input = await keyInput("OpenAI");
    fireEvent.change(input, { target: { value: TEST_KEY } });
    fireEvent.click(
      within(screen.getByRole("listitem", { name: "OpenAI" })).getByRole("button", {
        name: m.save,
      }),
    );
    expect(await screen.findByText(m.keySaved)).toBeTruthy();
    expect(sent("PUT")).toEqual([{ path: "/me/keys/openai", body: { apiKey: TEST_KEY } }]);
    expect((await keyInput("OpenAI")).value).toBe("");
    // The list refetches and shows only the last four.
    expect(await screen.findByText("••••abcd")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(TEST_KEY);
  });

  it("checks the key's length before sending it", async () => {
    const { sent } = await renderSettings();
    fireEvent.change(await keyInput("OpenAI"), { target: { value: "short" } });
    fireEvent.submit((await keyInput("OpenAI")).form!);
    expect(await screen.findByText("A key has at least 8 characters.")).toBeTruthy();
    expect(sent("PUT")).toEqual([]);
  });

  it("deletes a key with DELETE only after the confirmation", async () => {
    const { sent } = await renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Delete the Google Gemini key" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(sent("DELETE")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: m.confirmDelete }));
    expect(await screen.findByText(m.keyDeleted)).toBeTruthy();
    expect(sent("DELETE")).toEqual([{ path: "/me/keys/gemini", body: undefined }]);
    await waitFor(() => expect(screen.queryByText("••••x9Qz")).toBeNull());
  });

  it("explains a 403 on save", async () => {
    await renderSettings((request) => (request.method === "PUT" ? problem(403) : undefined));
    fireEvent.change(await keyInput("OpenAI"), { target: { value: TEST_KEY } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));
    expect(await screen.findByText(m.errors.keyForbidden)).toBeTruthy();
    expect((await keyInput("OpenAI")).getAttribute("aria-invalid")).toBe("true");
  });

  it("explains a 503 when the server can't store keys", async () => {
    await renderSettings((request) => (request.method === "PUT" ? problem(503) : undefined));
    fireEvent.change(await keyInput("OpenAI"), { target: { value: TEST_KEY } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));
    expect(await screen.findByText(m.errors.keysUnavailable)).toBeTruthy();
  });

  it("saves a default model, and the deployment default as null", async () => {
    const { sent } = await renderSettings();
    const select = await modelSelect();
    expect(select.value).toBe("");
    // Grouped by provider; local providers are not offered.
    expect(within(select).getByRole("group", { name: "Google Gemini" })).toBeTruthy();
    expect(within(select).queryByRole("group", { name: "Ollama" })).toBeNull();

    fireEvent.change(select, { target: { value: optionValue("gemini-1.5-pro") } });
    await waitFor(() => expect(select.value).toBe(optionValue("gemini-1.5-pro")));
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: optionValue(m.deploymentDefault) } });
    await waitFor(() => expect(select.value).toBe(""));
    await waitFor(() => expect(sent("PATCH")).toHaveLength(2));
    expect(sent("PATCH").map((r) => r.body)).toEqual([
      { defaultModel: { providerId: "gemini", model: "gemini-1.5-pro" } },
      { defaultModel: null },
    ]);
  });

  it("warns when the chosen model's provider has no key", async () => {
    settings.defaultModel = { providerId: "openai", model: "gpt-4o-mini" };
    await renderSettings();
    expect((await modelSelect()).value).toBe(optionValue("gpt-4o-mini"));
    expect(
      screen.getByText("Questions use the deployment's model until you add a key for OpenAI."),
    ).toBeTruthy();
  });

  it("shows an empty state when no provider is enabled", async () => {
    await renderSettings((_request, path) => (path === "/models" ? json([]) : undefined));
    expect(await screen.findByText(m.empty)).toBeTruthy();
    expect(screen.queryByLabelText(m.defaultLabel)).toBeNull();
  });

  it("offers a retry when the providers can't be loaded", async () => {
    let failing = true;
    await renderSettings((_request, path) =>
      path === "/models" && failing ? problem(500) : undefined,
    );
    expect(await screen.findByText(m.loadError)).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole("button", { name: en.Settings.retry }));
    expect(await screen.findByRole("listitem", { name: "Google Gemini" })).toBeTruthy();
  });
});
