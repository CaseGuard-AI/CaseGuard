import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const A = "00000000-0000-4000-8000-0000000000e1";
const B = "00000000-0000-4000-8000-0000000000e2";
const C = "00000000-0000-4000-8000-0000000000e3";
const NEW = "00000000-0000-4000-8000-0000000000e4";
const CURSOR = "next-page";
const NOW = new Date("2026-11-12T12:00:00Z");

const summary = (id: string, title: string, updatedAt: string) => ({
  id,
  title,
  caseId: null,
  createdAt: updatedAt,
  updatedAt,
});

const first = [
  summary(A, "Bail in a non-bailable offence", "2026-11-12T11:00:00Z"),
  summary(B, "Notice before eviction", "2026-11-10T09:00:00Z"),
];
const second = [summary(C, "Limitation for a civil suit", "2026-10-01T09:00:00Z")];

const thread = (id: string, question: string) => ({
  ...summary(id, question, "2026-11-12T11:00:00Z"),
  messages: [{ id: `u-${id}`, role: "user", text: question, createdAt: "2026-11-12T11:00:00Z" }],
});

const answer = {
  id: "00000000-0000-4000-8000-0000000000d1",
  role: "assistant",
  text: "No answer in the corpus.",
  language: "en",
  answerable: false,
  citations: [],
  createdAt: "2026-11-12T12:00:00Z",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Route = (method: string, path: string, query: URLSearchParams) => Response | undefined;

// Two pages of history (`?cursor=next-page` is the second) and a thread for each conversation.
const historyRoutes: Route = (method, path, query) => {
  if (method !== "GET") return undefined;
  if (path === "/conversations")
    return query.get("cursor") === CURSOR
      ? json({ items: second, nextCursor: null })
      : json({ items: first, nextCursor: CURSOR });
  const known = [...first, ...second].find((c) => path === `/conversations/${c.id}`);
  if (known) return json(thread(known.id, `Thread of ${known.title}`));
};

async function renderHub(route: Route = historyRoutes) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname.replace("/api/v1", "");
    return route(request.method, path, url.searchParams) ?? problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { ResearchHub } = await import("@/components/research/research-hub");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const view = () => (
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="ur" messages={ur} timeZone="Asia/Karachi" now={NOW}>
        <ResearchHub />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(view());
  // The mocked router only changes `nav.search`; re-rendering stands in for Next's update.
  return { fetchMock, rerender: () => rerender(view()) };
}

const historyNav = () => screen.getByRole("navigation", { name: ur.Research.history.title });
const titles = () =>
  within(historyNav())
    .getAllByRole("listitem")
    .map((li) => li.querySelector("[dir=auto]")?.textContent);
const historyCalls = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) =>
  fetchMock.mock.calls
    .map(([r]) => r as Request)
    .filter((r) => r.method === "GET" && new URL(r.url).pathname === "/api/v1/conversations")
    .map((r) => new URL(r.url).searchParams);

beforeEach(() => {
  nav.replace.mockReset();
  nav.replace.mockImplementation((url: string) => {
    nav.search = new URL(url, "http://localhost").search;
  });
  nav.search = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Research history (FR-RES-8)", () => {
  it("lists conversations newest first with a relative date", async () => {
    const { fetchMock } = await renderHub();
    await within(historyNav()).findByText(first[0].title);
    expect(titles()).toEqual([first[0].title, first[1].title]);
    const firstItem = within(historyNav()).getAllByRole("listitem")[0];
    // An hour before NOW, in Urdu.
    expect(firstItem.textContent).toContain("1 گھنٹہ پہلے");
    expect(historyCalls(fetchMock)[0].get("limit")).toBe("20");
    expect(historyCalls(fetchMock)[0].has("cursor")).toBe(false);
  });

  it("marks the conversation in ?c= as the current one", async () => {
    nav.search = `c=${B}`;
    await renderHub();
    const active = await within(historyNav()).findByRole("button", { current: "page" });
    expect(active.textContent).toContain(first[1].title);
    const other = within(historyNav()).getByRole("button", { name: new RegExp(first[0].title) });
    expect(other.getAttribute("aria-current")).toBeNull();
  });

  it("switches ?c= and loads that thread when an item is clicked", async () => {
    const { rerender, fetchMock } = await renderHub();
    fireEvent.click(await within(historyNav()).findByText(first[1].title));
    expect(nav.replace).toHaveBeenCalledWith(`/research?c=${B}`);
    rerender();
    expect(await screen.findByText(`Thread of ${first[1].title}`)).toBeTruthy();
    expect(within(historyNav()).getByRole("button", { current: "page" }).textContent).toContain(
      first[1].title,
    );
    expect(
      fetchMock.mock.calls.some(
        ([r]) => new URL((r as Request).url).pathname === `/api/v1/conversations/${B}`,
      ),
    ).toBe(true);
  });

  it("loads the next page with the cursor", async () => {
    const { fetchMock } = await renderHub();
    fireEvent.click(
      await within(historyNav()).findByRole("button", { name: ur.Research.history.loadMore }),
    );
    await within(historyNav()).findByText(second[0].title);
    expect(titles()).toEqual([first[0].title, first[1].title, second[0].title]);
    expect(historyCalls(fetchMock).at(-1)?.get("cursor")).toBe(CURSOR);
    expect(
      within(historyNav()).queryByRole("button", { name: ur.Research.history.loadMore }),
    ).toBeNull();
  });

  it("puts a new conversation at the top after a question, without a reload", async () => {
    let asked = false;
    const { fetchMock } = await renderHub((method, path, query) => {
      if (method === "POST" && path === "/conversations")
        return json({ ...summary(NEW, "New conversation", answer.createdAt), messages: [] }, 201);
      if (method === "POST" && path === `/conversations/${NEW}/messages`) {
        asked = true;
        return json(answer, 201);
      }
      if (method === "GET" && path === "/conversations" && asked)
        return json({
          items: [summary(NEW, "Is a verbal agreement binding?", answer.createdAt), ...first],
          nextCursor: CURSOR,
        });
      return historyRoutes(method, path, query);
    });
    await within(historyNav()).findByText(first[0].title);
    fireEvent.change(screen.getByLabelText(ur.Research.placeholder), {
      target: { value: "Is a verbal agreement binding?" },
    });
    fireEvent.click(screen.getByRole("button", { name: ur.Research.submit }));
    await within(historyNav()).findByText("Is a verbal agreement binding?");
    expect(titles()[0]).toBe("Is a verbal agreement binding?");
    expect(historyCalls(fetchMock).length).toBeGreaterThanOrEqual(2);
  });

  it("starts a new question by clearing ?c=", async () => {
    nav.search = `c=${A}`;
    await renderHub();
    await within(historyNav()).findByText(first[0].title);
    fireEvent.click(
      within(historyNav()).getByRole("button", { name: ur.Research.history.newQuestion }),
    );
    expect(nav.replace).toHaveBeenCalledWith("/research");
  });

  it("says when there are no conversations yet", async () => {
    await renderHub((method, path) =>
      method === "GET" && path === "/conversations"
        ? json({ items: [], nextCursor: null })
        : undefined,
    );
    expect(await within(historyNav()).findByText(ur.Research.history.empty)).toBeTruthy();
  });

  it("offers a retry when the history can't be loaded", async () => {
    let fail = true;
    await renderHub((method, path, query) =>
      method === "GET" && path === "/conversations" && fail
        ? problem(503)
        : historyRoutes(method, path, query),
    );
    expect(await within(historyNav()).findByText(ur.Research.history.error)).toBeTruthy();
    fail = false;
    fireEvent.click(within(historyNav()).getByRole("button", { name: ur.Research.history.retry }));
    await waitFor(() => expect(titles()).toEqual([first[0].title, first[1].title]));
  });

  it("opens the history in a drawer on small screens and closes it after a choice", async () => {
    await renderHub();
    fireEvent.click(screen.getByRole("button", { name: ur.Research.history.open }));
    const drawer = await screen.findByRole("dialog");
    fireEvent.click(await within(drawer).findByText(first[1].title));
    expect(nav.replace).toHaveBeenCalledWith(`/research?c=${B}`);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
