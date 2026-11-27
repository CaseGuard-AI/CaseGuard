import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ur from "../messages/ur.json";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props} />
  ),
}));

const NOW = new Date("2026-11-12T12:00:00Z");
const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

const conversation = (n: number, updatedAt: string) => ({
  id: id(n),
  title: `Question ${n}`,
  caseId: null,
  createdAt: updatedAt,
  updatedAt,
});
// Six conversations on the first page: the dashboard shows only the top five.
const conversations = [1, 2, 3, 4, 5, 6].map((n) =>
  conversation(n, n === 1 ? "2026-11-12T11:00:00Z" : "2026-11-01T09:00:00Z"),
);

const aCase = (n: number, fields: Record<string, unknown> = {}) => ({
  id: id(50 + n),
  title: `State v. Accused ${n}`,
  court: null,
  caseNumber: null,
  caseType: null,
  filedOn: null,
  status: null,
  nextHearingOn: null,
  parties: [],
  judge: null,
  assignedLawyer: null,
  relevantLaws: [],
  summary: null,
  createdAt: "2026-11-01T09:00:00Z",
  updatedAt: "2026-11-10T09:00:00Z",
  archivedAt: null,
  ...fields,
});
const cases = [
  aCase(1, {
    court: "Sindh High Court, Karachi",
    caseNumber: "Cr. Bail No. 1234 of 2026",
    nextHearingOn: "2026-12-03",
  }),
  aCase(2),
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Route = (path: string) => Response | undefined;

const draft = (n: number, updatedAt: string) => ({
  id: id(80 + n),
  title: `Bail application ${n}`,
  templateId: "bail_application",
  caseId: null,
  version: 1,
  updatedAt,
});
// Six drafts on the first page: the dashboard shows only the top five.
const drafts = [1, 2, 3, 4, 5, 6].map((n) =>
  draft(n, n === 1 ? "2026-11-12T10:00:00Z" : "2026-11-02T09:00:00Z"),
);

const routes: Route = (path) => {
  if (path === "/conversations") return json({ items: conversations, nextCursor: "next" });
  if (path === "/cases") return json({ items: cases, nextCursor: null });
  if (path === "/drafts") return json({ items: drafts, nextCursor: "next" });
};

async function renderDashboard(route: Route = routes) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname.replace("/api/v1", "");
    return (request.method === "GET" && route(path)) || problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { Dashboard } = await import("@/components/dashboard/dashboard");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="ur" messages={ur} timeZone="Asia/Karachi" now={NOW}>
        <Dashboard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { fetchMock };
}

const section = (name: string) => screen.getByRole("region", { name });
const research = () => section(ur.Dashboard.research.title);
const caseList = () => section(ur.Dashboard.cases.title);
const draftList = () => section(ur.Dashboard.drafts.title);
const hrefs = (el: HTMLElement) =>
  within(el)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("a")?.getAttribute("href"));
const queryOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, path: string) =>
  fetchMock.mock.calls
    .map(([r]) => new URL((r as Request).url))
    .find((url) => url.pathname === `/api/v1${path}`)?.searchParams;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard (FR-DASH-1)", () => {
  it("links to the Research Hub to ask a question", async () => {
    await renderDashboard();
    expect(screen.getByRole("link", { name: ur.Dashboard.ask.start }).getAttribute("href")).toBe(
      "/research",
    );
  });

  it("lists the five most recent conversations, each opening its thread", async () => {
    await renderDashboard();
    await within(research()).findByText("Question 1");
    expect(hrefs(research())).toEqual([1, 2, 3, 4, 5].map((n) => `/research?c=${id(n)}`));
    expect(within(research()).queryByText("Question 6")).toBeNull();
    // An hour before NOW, in Urdu.
    expect(within(research()).getAllByRole("listitem")[0].textContent).toContain("1 گھنٹہ پہلے");
    expect(
      within(research())
        .getByRole("link", { name: ur.Dashboard.research.seeAll })
        .getAttribute("href"),
    ).toBe("/research");
  });

  it("lists recent cases with their details, each opening the case", async () => {
    const { fetchMock } = await renderDashboard();
    await within(caseList()).findByText(cases[0].title);
    expect(hrefs(caseList())).toEqual([`/cases/${id(51)}`, `/cases/${id(52)}`]);
    const first = within(caseList()).getAllByRole("listitem")[0];
    expect(first.textContent).toContain("Cr. Bail No. 1234 of 2026 · Sindh High Court, Karachi");
    expect(first.textContent).toContain(ur.Dashboard.cases.nextHearing.replace(" {date}", ""));
    expect(first.textContent).toContain("2026");
    // A case without a hearing date says nothing about one.
    const second = within(caseList()).getAllByRole("listitem")[1];
    expect(second.textContent).not.toContain(ur.Dashboard.cases.nextHearing.replace(" {date}", ""));
    expect(queryOf(fetchMock, "/cases")?.get("limit")).toBe("5");
    expect(queryOf(fetchMock, "/cases")?.has("state")).toBe(false);
    expect(
      within(caseList())
        .getByRole("link", { name: ur.Dashboard.cases.seeAll })
        .getAttribute("href"),
    ).toBe("/cases");
  });

  it("lists the five most recent drafts, each opening in the Drafting Studio", async () => {
    await renderDashboard();
    await within(draftList()).findByText("Bail application 1");
    expect(hrefs(draftList())).toEqual([1, 2, 3, 4, 5].map((n) => `/drafting/${id(80 + n)}`));
    expect(within(draftList()).queryByText("Bail application 6")).toBeNull();
    // Two hours before NOW, in Urdu.
    expect(within(draftList()).getAllByRole("listitem")[0].textContent).toContain("2 گھنٹے پہلے");
    expect(
      within(draftList())
        .getByRole("link", { name: ur.Dashboard.drafts.seeAll })
        .getAttribute("href"),
    ).toBe("/drafting");
  });

  it("says when there is no research, no case and no draft yet", async () => {
    await renderDashboard((path) =>
      path === "/conversations" || path === "/cases" || path === "/drafts"
        ? json({ items: [], nextCursor: null })
        : undefined,
    );
    expect(await within(research()).findByText(ur.Dashboard.research.empty)).toBeTruthy();
    expect(await within(caseList()).findByText(ur.Dashboard.cases.empty)).toBeTruthy();
    expect(await within(draftList()).findByText(ur.Dashboard.drafts.empty)).toBeTruthy();
  });

  it("shows an error with a retry in one section without hiding the other", async () => {
    let fail = true;
    await renderDashboard((path) => (path === "/cases" && fail ? problem(503) : routes(path)));
    expect(await within(caseList()).findByRole("alert")).toBeTruthy();
    expect(within(caseList()).getByText(ur.Dashboard.error)).toBeTruthy();
    await within(research()).findByText("Question 1");
    fail = false;
    fireEvent.click(within(caseList()).getByRole("button", { name: ur.Dashboard.retry }));
    await waitFor(() => expect(hrefs(caseList())).toHaveLength(2));
  });
});
