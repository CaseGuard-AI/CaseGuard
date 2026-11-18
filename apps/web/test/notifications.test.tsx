import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

const NOW = new Date("2026-11-19T12:00:00Z");
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const CASE = id(90);

const notification = (n: number, kind: string, readAt: string | null = null) => ({
  id: id(n),
  kind,
  documentId: id(40 + n),
  caseId: CASE,
  filename: `doc-${n}.pdf`,
  readAt,
  createdAt: "2026-11-19T11:00:00Z",
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Route = (method: string, path: string, query: URLSearchParams) => Response | undefined;

const listOf =
  (items: unknown[], unreadCount: number): Route =>
  (method, path, query) => {
    if (method === "GET" && path === "/notifications") {
      const limit = Number(query.get("limit") ?? 20);
      return json({ items: items.slice(0, limit), nextCursor: null, unreadCount });
    }
    if (method === "POST" && path.startsWith("/notifications/"))
      return new Response(null, { status: 204 });
  };

async function renderBell(route: Route) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname.replace("/api/v1", "");
    return route(request.method, path, url.searchParams) ?? problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { NotificationBell } = await import("@/components/notifications/notification-bell");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Karachi" now={NOW}>
        <NotificationBell />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { fetchMock };
}

const calls = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, method: string, path: string) =>
  fetchMock.mock.calls.filter(([r]) => {
    const request = r as Request;
    return request.method === method && new URL(request.url).pathname === `/api/v1${path}`;
  });

const t = en.Notifications;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationBell (FR-NOT-1)", () => {
  it("shows no dot when nothing is unread", async () => {
    const { fetchMock } = await renderBell(listOf([], 0));
    await waitFor(() => expect(calls(fetchMock, "GET", "/notifications")).toHaveLength(1));
    expect(screen.getByRole("button", { name: t.open })).toBeTruthy();
    expect(screen.queryByTestId("unread-dot")).toBeNull();
  });

  it("asks for one notification only, and shows the dot with the unread count", async () => {
    const { fetchMock } = await renderBell(listOf([notification(1, "document_done")], 3));
    await screen.findByTestId("unread-dot");
    expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeTruthy();
    const url = new URL((calls(fetchMock, "GET", "/notifications")[0]![0] as Request).url);
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("opens the sheet with each kind worded, linking to the case", async () => {
    await renderBell(
      listOf(
        [
          notification(1, "document_done"),
          notification(2, "document_flagged"),
          notification(3, "document_failed", "2026-11-19T11:30:00Z"),
          notification(4, "report_ready"),
        ],
        3,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: /Notifications, 3 unread/ }));
    const dialog = await screen.findByRole("dialog", { name: t.title });
    await within(dialog).findByText("doc-1.pdf is processed and ready to use.");
    expect(
      within(dialog).getByText("doc-2.pdf is processed, but some parts are flagged for review."),
    ).toBeTruthy();
    expect(within(dialog).getByText("doc-3.pdf could not be processed.")).toBeTruthy();
    // A kind the client doesn't know yet still renders, generically.
    expect(within(dialog).getByText("There is an update about doc-4.pdf.")).toBeTruthy();
    const links = within(dialog).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(Array(4).fill(`/cases/${CASE}`));
    expect(links.map((a) => a.hasAttribute("data-unread"))).toEqual([true, true, false, true]);
  });

  it("marks an unread notification read when it is opened", async () => {
    const { fetchMock } = await renderBell(listOf([notification(1, "document_done")], 1));
    fireEvent.click(await screen.findByRole("button", { name: /1 unread/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("link"));
    await waitFor(() =>
      expect(calls(fetchMock, "POST", `/notifications/${id(1)}/read`)).toHaveLength(1),
    );
  });

  it("marks all read", async () => {
    const { fetchMock } = await renderBell(listOf([notification(1, "document_done")], 1));
    fireEvent.click(await screen.findByRole("button", { name: /1 unread/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: t.markAllRead }));
    await waitFor(() =>
      expect(calls(fetchMock, "POST", "/notifications/read-all")).toHaveLength(1),
    );
  });

  it("says so when there is nothing yet", async () => {
    await renderBell(listOf([], 0));
    fireEvent.click(await screen.findByRole("button", { name: t.open }));
    expect(await screen.findByText(t.empty)).toBeTruthy();
  });

  it("offers a retry when the list fails", async () => {
    await renderBell((method, path, query) =>
      query.get("limit") === "1"
        ? json({ items: [], nextCursor: null, unreadCount: 0 })
        : problem(500),
    );
    fireEvent.click(await screen.findByRole("button", { name: t.open }));
    expect(await screen.findByRole("button", { name: t.retry })).toBeTruthy();
  });
});
