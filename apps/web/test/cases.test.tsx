import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const m = en.Cases;
const CASE = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const OLD = "00000000-0000-4000-8000-0000000000a3";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const CURSOR = "next-page";
const NOW = new Date("2026-11-18T12:00:00Z");

const legalCase = (id: string, title: string, extra: object = {}) => ({
  id,
  title,
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
  updatedAt: "2026-11-18T11:00:00Z",
  archivedAt: null,
  ...extra,
});

const bail = legalCase(CASE, "State v. Ahmed", {
  court: "Sindh High Court, Karachi",
  caseNumber: "Cr. Bail No. 1234 of 2026",
  caseType: "Cr. Bail",
  status: "Arguments",
  nextHearingOn: "2026-12-02",
  judge: "Justice A",
  parties: [
    { side: "claimant", name: "Ahmed Khan", label: "Applicant" },
    { side: "respondent", name: "The State" },
  ],
  relevantLaws: ["s.497 CrPC"],
  summary: "Post-arrest bail.",
});
const rent = legalCase(OTHER, "Rent dispute");
const archived = legalCase(OLD, "Closed matter", { archivedAt: "2026-11-10T09:00:00Z" });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number, extra: object = {}) =>
  json({ type: "about:blank", title: "Error", status, ...extra }, status);

type Route = (
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
) => Response | undefined;

async function renderWith(load: () => Promise<ReactElement>, route: Route) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? JSON.parse(text) : undefined;
    return (
      route(request.method, url.pathname.replace("/api/v1", ""), url.searchParams, body) ??
      problem(404)
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const element = await load();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Karachi" now={NOW}>
        {element}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  const calls = (method: string, path: string) =>
    fetchMock.mock.calls
      .map(([r]) => r as Request)
      .filter((r) => r.method === method && new URL(r.url).pathname === `/api/v1${path}`);
  return { fetchMock, calls };
}

const renderList = (route: Route) =>
  renderWith(async () => {
    const { CasesList } = await import("@/components/cases/cases-list");
    return <CasesList />;
  }, route);
const renderForm = (route: Route = () => undefined) =>
  renderWith(async () => {
    const { CaseForm } = await import("@/components/cases/case-form");
    return <CaseForm />;
  }, route);
const renderEdit = (route: Route) =>
  renderWith(async () => {
    const { CaseEdit } = await import("@/components/cases/case-edit");
    return <CaseEdit caseId={CASE} />;
  }, route);
const renderDashboard = (route: Route, id = CASE) =>
  renderWith(async () => {
    const { CaseDashboard } = await import("@/components/cases/case-dashboard");
    return <CaseDashboard caseId={id} />;
  }, route);

beforeEach(() => {
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Cases list (FR-CASE-1)", () => {
  const listRoute: Route = (method, path, query) => {
    if (method !== "GET" || path !== "/cases") return undefined;
    if (query.get("state") === "archived") return json({ items: [archived], nextCursor: null });
    return query.get("cursor") === CURSOR
      ? json({ items: [rent], nextCursor: null })
      : json({ items: [bail], nextCursor: CURSOR });
  };

  it("lists active cases with their number, court, next hearing and update time", async () => {
    const { calls } = await renderList(listRoute);
    const link = await screen.findByRole("link", { name: new RegExp(bail.title) });
    expect(link.getAttribute("href")).toBe(`/cases/${CASE}`);
    expect(link.textContent).toContain(bail.caseNumber);
    expect(link.textContent).toContain(bail.court);
    expect(link.textContent).toContain("Next hearing Dec 2, 2026");
    expect(link.textContent).toContain("Updated 1 hour ago");
    const query = new URL(calls("GET", "/cases")[0].url).searchParams;
    expect(query.get("state")).toBe("active");
    expect(query.get("limit")).toBe("20");
  });

  it("loads the next page with the cursor", async () => {
    const { calls } = await renderList(listRoute);
    fireEvent.click(await screen.findByRole("button", { name: m.list.loadMore }));
    expect(await screen.findByRole("link", { name: new RegExp(rent.title) })).toBeTruthy();
    expect(new URL(calls("GET", "/cases").at(-1)!.url).searchParams.get("cursor")).toBe(CURSOR);
    expect(screen.queryByRole("button", { name: m.list.loadMore })).toBeNull();
  });

  it("shows archived cases on their own tab", async () => {
    const { calls } = await renderList(listRoute);
    await screen.findByRole("link", { name: new RegExp(bail.title) });
    fireEvent.mouseDown(screen.getByRole("tab", { name: m.tabs.archived }));
    expect(await screen.findByRole("link", { name: new RegExp(archived.title) })).toBeTruthy();
    expect(
      calls("GET", "/cases").some((r) => new URL(r.url).searchParams.get("state") === "archived"),
    ).toBe(true);
  });

  it("says when there are no cases yet", async () => {
    await renderList((method, path) =>
      method === "GET" && path === "/cases" ? json({ items: [], nextCursor: null }) : undefined,
    );
    expect(await screen.findByText(m.list.emptyActive)).toBeTruthy();
  });

  it("offers a retry when the list can't be loaded", async () => {
    let fail = true;
    await renderList((method, path, query, body) =>
      fail && path === "/cases" ? problem(503) : listRoute(method, path, query, body),
    );
    expect(await screen.findByText(m.list.error)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: m.list.retry }));
    expect(await screen.findByRole("link", { name: new RegExp(bail.title) })).toBeTruthy();
  });
});

describe("Case form (FR-CASE-1)", () => {
  const type = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("checks the title and each party before sending anything", async () => {
    const { calls } = await renderForm();
    fireEvent.click(screen.getByRole("button", { name: m.form.create }));
    expect(await screen.findByText(m.form.errors.titleRequired)).toBeTruthy();
    type(m.fields.title, "State v. Ahmed");
    fireEvent.click(screen.getByRole("button", { name: m.form.addParty }));
    fireEvent.click(screen.getByRole("button", { name: m.form.create }));
    expect(await screen.findByText(m.form.errors.partyName)).toBeTruthy();
    expect(screen.queryByText(m.form.errors.titleRequired)).toBeNull();
    expect(calls("POST", "/cases")).toHaveLength(0);
  });

  it("creates a case with only the filled-in fields and opens it", async () => {
    let sent: unknown;
    await renderForm((method, path, _q, body) => {
      if (method === "POST" && path === "/cases") {
        sent = body;
        return json(legalCase(CASE, "State v. Ahmed"), 201);
      }
    });
    type(m.fields.title, "  State v. Ahmed  ");
    type(m.fields.court, "Sindh High Court");
    type(m.fields.nextHearingOn, "2026-12-02");
    fireEvent.click(screen.getByRole("button", { name: m.form.addParty }));
    fireEvent.change(screen.getByLabelText(m.form.partySide.replace("{n}", "1")), {
      target: { value: "respondent" },
    });
    type(m.form.partyName.replace("{n}", "1"), "The State");
    fireEvent.click(screen.getByRole("button", { name: m.form.addLaw }));
    type(m.form.law.replace("{n}", "1"), "s.497 CrPC");
    fireEvent.click(screen.getByRole("button", { name: m.form.create }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/cases/${CASE}`));
    expect(sent).toEqual({
      title: "State v. Ahmed",
      court: "Sindh High Court",
      nextHearingOn: "2026-12-02",
      parties: [{ side: "respondent", name: "The State" }],
      relevantLaws: ["s.497 CrPC"],
    });
  });

  it("shows a 400 at the field it names, and the rest in the form's alert", async () => {
    await renderForm((method, path) =>
      method === "POST" && path === "/cases"
        ? problem(400, {
            errors: [
              { path: "caseNumber", message: "Too long" },
              { path: "somethingElse", message: "Unknown" },
            ],
          })
        : undefined,
    );
    type(m.fields.title, "State v. Ahmed");
    type(m.fields.caseNumber, "123");
    fireEvent.click(screen.getByRole("button", { name: m.form.create }));
    expect(await screen.findByText(m.form.errors.rejected)).toBeTruthy();
    expect(screen.getByLabelText(m.fields.caseNumber).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(m.form.errors.server);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("edits by sending only the changed fields, with null for a cleared one", async () => {
    let sent: unknown;
    await renderEdit((method, path, _q, body) => {
      if (method === "GET" && path === `/cases/${CASE}`) return json(bail);
      if (method === "PATCH" && path === `/cases/${CASE}`) {
        sent = body;
        return json({ ...bail, ...(body as object) });
      }
    });
    const save = await screen.findByRole("button", { name: m.form.save });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(m.fields.court) as HTMLInputElement).value).toBe(bail.court);
    type(m.fields.court, "");
    type(m.fields.status, "Reserved for judgment");
    fireEvent.click(screen.getByRole("button", { name: m.form.removeLaw.replace("{n}", "1") }));
    fireEvent.click(save);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/cases/${CASE}`));
    expect(sent).toEqual({ court: null, status: "Reserved for judgment", relevantLaws: [] });
  });
});

describe("Case dashboard (FR-CASE-4)", () => {
  // The case as the server holds it: archiving changes what a later GET returns.
  const dashRoute = (start: object = bail): Route => {
    let item = start;
    return (method, path, query) => {
      if (method === "GET" && path === `/cases/${CASE}`) return json(item);
      if (method === "GET" && path === "/conversations" && query.get("caseId") === CASE)
        return json({
          items: [
            {
              id: CONV,
              title: "Is bail a right here?",
              caseId: CASE,
              createdAt: "2026-11-18T10:00:00Z",
              updatedAt: "2026-11-18T10:00:00Z",
            },
          ],
          nextCursor: null,
        });
      if (method === "POST" && path === `/cases/${CASE}/archive`) {
        item = { ...item, archivedAt: NOW.toISOString() };
        return json(item);
      }
    };
  };

  it("shows the case, its parties by side and its research", async () => {
    await renderDashboard(dashRoute());
    expect(await screen.findByRole("heading", { name: bail.title })).toBeTruthy();
    expect(screen.getByText("Sindh High Court, Karachi")).toBeTruthy();
    expect(screen.getByText("Dec 2, 2026")).toBeTruthy();
    expect(screen.getByText("Ahmed Khan")).toBeTruthy();
    expect(screen.getByText("s.497 CrPC")).toBeTruthy();
    const research = await screen.findByRole("list", { name: m.dashboard.research.title });
    expect(within(research).getByRole("link").getAttribute("href")).toBe(`/research?c=${CONV}`);
    expect(screen.getByRole("link", { name: m.dashboard.ask }).getAttribute("href")).toBe(
      `/research?case=${CASE}`,
    );
    expect(screen.getByRole("heading", { name: en.Documents.card.title })).toBeTruthy();
  });

  it("links the whole precedents card to precedent search", async () => {
    await renderDashboard(dashRoute());
    const heading = await screen.findByRole("heading", { name: m.dashboard.precedents.title });
    const card = heading.closest("a");
    expect(card?.getAttribute("href")).toBe("/precedents");
    expect(card?.textContent).toContain(m.dashboard.precedents.action);
    // The old placeholder said precedent search wasn't available yet.
    expect(screen.queryByText(/once precedent search is available/)).toBeNull();
  });

  it("archives only after the confirmation, then hides asking in the case", async () => {
    const { calls } = await renderDashboard(dashRoute());
    fireEvent.click(await screen.findByRole("button", { name: m.dashboard.archive }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls("POST", `/cases/${CASE}/archive`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: m.dashboard.archiveConfirm }));
    expect(await screen.findByText(m.dashboard.archivedBanner)).toBeTruthy();
    expect(calls("POST", `/cases/${CASE}/archive`)).toHaveLength(1);
    expect(screen.queryByRole("link", { name: m.dashboard.ask })).toBeNull();
    expect(screen.getByRole("button", { name: m.dashboard.unarchive })).toBeTruthy();
  });

  it("says when the case is not found", async () => {
    await renderDashboard(() => undefined);
    expect(await screen.findByRole("heading", { name: m.dashboard.notFoundTitle })).toBeTruthy();
    expect(screen.getByRole("link", { name: m.dashboard.back }).getAttribute("href")).toBe(
      "/cases",
    );
  });
});
