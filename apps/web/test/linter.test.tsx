import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ search: "" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const m = en.Linter;
const CASE = "00000000-0000-4000-8000-0000000000a1";
const REPORT = "00000000-0000-4000-8000-0000000000e1";
const AT = "2026-11-21T11:00:00Z";
const NOW = new Date("2026-11-21T12:00:00Z");

// An emoji (two UTF-16 units) before the span: the highlight must still land on "FIR".
const TEXT = "\u{1F600} IN THE COURT OF SESSIONS JUDGE\nFIR registered at Kalakot\nPRAYER\n";
const FIR_AT = TEXT.indexOf("FIR");

const legalCase = {
  id: CASE,
  title: "State v. Aslam",
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
  createdAt: AT,
  updatedAt: AT,
  archivedAt: null,
};

const rulesets = {
  items: [
    {
      id: "bail_application",
      documentType: "bail_application",
      version: "1",
      title: "Bail application (ss.497 and 498 CrPC)",
      rules: [
        { id: "bail.fir_number", kind: "missing_particular", severity: "error", title: "FIR number", source: null },
        {
          id: "bail.grounds",
          kind: "missing_section",
          severity: "error",
          title: "Grounds",
          source: { provision: "s.497(2) CrPC", reference: null },
        },
        {
          id: "bail.prayer_after_grounds",
          kind: "structure",
          severity: "warning",
          title: "Prayer after the grounds",
          source: null,
        },
      ],
    },
    { id: "plaint", documentType: "plaint", version: "1", title: "Plaint (Order VII CPC)", rules: [] },
  ],
};

const findings = [
  {
    ruleId: "bail.fir_number",
    kind: "missing_particular",
    severity: "error",
    message: "Could not find the FIR number.",
    span: { start: FIR_AT, end: FIR_AT + 3 },
    source: null,
  },
  {
    ruleId: "bail.prayer_after_grounds",
    kind: "structure",
    severity: "warning",
    message: "The prayer comes before the grounds; it should close the application.",
    span: { start: TEXT.indexOf("PRAYER"), end: TEXT.indexOf("PRAYER") + 6 },
    source: null,
  },
  {
    ruleId: "bail.grounds",
    kind: "missing_section",
    severity: "error",
    message: "Could not find the grounds for bail.",
    span: null,
    source: { provision: "s.497(2) CrPC", reference: null },
  },
];

const report = (extra: object = {}) => ({
  id: REPORT,
  documentType: "bail_application",
  title: "Bail application, 2026-11-21",
  caseId: null,
  draftId: null,
  text: TEXT,
  inputSha256: "a".repeat(64),
  rulesetId: "bail_application",
  rulesetVersion: "1",
  findings,
  createdAt: AT,
  ...extra,
});
const summaryOf = (r: ReturnType<typeof report>) => ({
  id: r.id,
  documentType: r.documentType,
  title: r.title,
  caseId: r.caseId,
  draftId: r.draftId,
  findingCounts: { error: 2, warning: 1, info: 0 },
  createdAt: r.createdAt,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number, extra: object = {}) =>
  json({ type: "about:blank", title: "Error", status, ...extra }, status);

type Seen = { method: string; path: string; query: URLSearchParams; body: unknown };
type Route = (seen: Seen) => Response | undefined | Promise<Response | undefined>;

/** The API: rule sets, the user's one case, and whatever `route` adds. */
const base: Route = ({ method, path }) => {
  if (method === "GET" && path === "/lint/rulesets") return json(rulesets);
  if (method === "GET" && path === "/cases") return json({ items: [legalCase], nextCursor: null });
  if (method === "GET" && path === `/cases/${CASE}`) return json(legalCase);
  return undefined;
};

async function renderWith(
  load: () => Promise<ReactElement>,
  route: Route,
  messages: typeof en = en,
) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const url = new URL(request.url);
      const text = await request.clone().text();
      const entry = {
        method: request.method,
        path: url.pathname.replace("/api/v1", ""),
        query: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      return (await route(entry)) ?? (await base(entry)) ?? problem(404);
    }),
  );
  vi.resetModules();
  const element = await load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider
        locale={messages === en ? "en" : "ur"}
        messages={messages}
        timeZone="Asia/Karachi"
        now={NOW}
      >
        {element}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { calls: (method: string, path: string) => seen.filter((s) => s.method === method && s.path === path) };
}

const renderScreen = (route: Route, messages: typeof en = en) =>
  renderWith(async () => {
    const { LinterScreen } = await import("@/components/linter/linter-screen");
    return <LinterScreen />;
  }, route, messages);

/** Past reports: none, unless given. */
const reports =
  (items: ReturnType<typeof summaryOf>[] = []): Route =>
  ({ method, path }) =>
    method === "GET" && path === "/lint-reports" ? json({ items, nextCursor: null }) : undefined;

const textArea = () => screen.getByLabelText(m.form.textLabel);
const lintButton = () => screen.getByRole("button", { name: m.form.lint });

beforeEach(() => {
  nav.search = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the linter screen (FR-LINT-1, FR-LINT-2)", () => {
  it("lints the pasted text and shows the findings grouped by kind", async () => {
    const { calls } = await renderScreen((seen) =>
      seen.method === "POST" && seen.path === "/lint-reports"
        ? json(report(), 201)
        : reports()(seen),
    );
    expect((lintButton()) as HTMLButtonElement).toHaveProperty("disabled", true);
    fireEvent.change(textArea(), { target: { value: TEXT } });
    fireEvent.click(lintButton());

    const missing = await screen.findByRole("region", { name: m.result.kinds.missing_section });
    expect(calls("POST", "/lint-reports")[0]!.body).toEqual({
      documentType: "bail_application",
      text: TEXT,
    });
    expect(within(missing).getByText("Could not find the grounds for bail.")).toBeTruthy();
    expect(within(missing).getByText("s.497(2) CrPC")).toBeTruthy();
    expect(within(missing).getByText(m.result.wholeDocument)).toBeTruthy();

    const particulars = screen.getByRole("region", { name: m.result.kinds.missing_particular });
    // A null source says so, in words (FR-LINT-2), next to the rule's title from the rule set.
    expect(within(particulars).getByText(m.result.noSource)).toBeTruthy();
    expect(await within(particulars).findByText("FIR number")).toBeTruthy();
    expect(screen.getByRole("region", { name: m.result.kinds.structure })).toBeTruthy();
    expect(screen.getByText("2 errors")).toBeTruthy();
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(
      screen.getByText("Checked against “Bail application (ss.497 and 498 CrPC)”, rule set version 1."),
    ).toBeTruthy();
  });

  it("highlights a finding's span in the read-only text, by UTF-16 offsets", async () => {
    nav.search = `?report=${REPORT}`;
    await renderScreen((seen) =>
      seen.method === "GET" && seen.path === `/lint-reports/${REPORT}`
        ? json(report())
        : reports([summaryOf(report())])(seen),
    );
    const view = await screen.findByLabelText(m.result.textTitle, { selector: "pre" });
    expect(view.textContent).toBe(TEXT);
    expect(screen.queryByTestId("lint-highlight")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Could not find the FIR number/ }));
    expect((screen.getByTestId("lint-highlight")).textContent).toMatch(/^FIR$/);
    expect(view.textContent).toBe(TEXT); // the text itself is never changed (FR-LINT-3)
    expect((screen.getByRole("button", { name: /Could not find the FIR number/ })).getAttribute("aria-pressed")).toBe("true",);

    fireEvent.click(screen.getByRole("button", { name: /The prayer comes before/ }));
    expect((screen.getByTestId("lint-highlight")).textContent).toMatch(/^PRAYER$/);
    // A finding about the whole document has nothing to highlight, so it isn't a button.
    expect(screen.queryByRole("button", { name: /grounds for bail/ })).toBeNull();
  });

  it("says when a report is clean", async () => {
    nav.search = `?report=${REPORT}`;
    await renderScreen((seen) =>
      seen.path === `/lint-reports/${REPORT}` ? json(report({ findings: [] })) : reports()(seen),
    );
    expect(await screen.findByText(m.result.clean)).toBeTruthy();
  });

  it("loads a .txt file in the browser and refuses anything else", async () => {
    await renderScreen(reports());
    const input = screen.getByLabelText(m.form.loadFile, { selector: "input" });
    fireEvent.change(input, {
      target: { files: [new File(["PLAINT TEXT"], "plaint.txt", { type: "text/plain" })] },
    });
    await waitFor(() => expect(((textArea()) as HTMLInputElement).value).toBe("PLAINT TEXT"));

    fireEvent.change(input, {
      target: { files: [new File(["%PDF"], "plaint.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByText(m.form.notText)).toBeTruthy();
    expect(((textArea()) as HTMLInputElement).value).toBe("PLAINT TEXT");
  });

  it("refuses text over the contract's limit, counting characters", async () => {
    await renderScreen(reports());
    fireEvent.change(textArea(), { target: { value: "x".repeat(200_001) } });
    expect(screen.getByText(/^The text is longer than 200,?000 characters\.$/)).toBeTruthy();
    expect((lintButton()) as HTMLButtonElement).toHaveProperty("disabled", true);
    // 150,000 emoji are 300,000 UTF-16 units but 150,000 characters: allowed.
    fireEvent.change(textArea(), { target: { value: "\u{1F600}".repeat(150_000) } });
    expect((lintButton()) as HTMLButtonElement).toHaveProperty("disabled", false);
  });

  it("saves to the case from ?case= and sends the chosen type", async () => {
    nav.search = `?case=${CASE}`;
    const { calls } = await renderScreen((seen) =>
      seen.method === "POST" && seen.path === "/lint-reports"
        ? json(report({ caseId: CASE, documentType: "plaint", rulesetId: "plaint" }), 201)
        : reports()(seen),
    );
    const select = screen.getByLabelText(m.form.caseLabel);
    await waitFor(() => expect(((select) as HTMLInputElement).value).toBe(CASE));
    fireEvent.change(screen.getByLabelText(m.form.typeLabel), { target: { value: "plaint" } });
    fireEvent.change(textArea(), { target: { value: TEXT } });
    fireEvent.click(lintButton());
    expect(await screen.findByText("Saved to State v. Aslam")).toBeTruthy();
    expect(calls("POST", "/lint-reports")[0]!.body).toEqual({
      documentType: "plaint",
      text: TEXT,
      caseId: CASE,
    });
  });

  it.each([
    [problem(400, { errors: [{ path: "caseId", message: "That case is archived" }] }), m.errors.caseId],
    [problem(429), m.errors.rateLimited],
    [problem(503), m.errors.unavailable],
  ])("puts a failed lint in words", async (response, message) => {
    await renderScreen((seen) =>
      seen.method === "POST" && seen.path === "/lint-reports" ? response : reports()(seen),
    );
    fireEvent.change(textArea(), { target: { value: TEXT } });
    fireEvent.click(lintButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(message);
  });

  it("saves an unsaved report to a case in place, with no second lint (FR-CASE-5)", async () => {
    nav.search = `?report=${REPORT}`;
    const { calls } = await renderScreen((seen) => {
      if (seen.method === "GET" && seen.path === `/lint-reports/${REPORT}`) return json(report());
      if (seen.method === "PATCH" && seen.path === `/lint-reports/${REPORT}`)
        return json(report({ caseId: CASE }));
      return reports()(seen);
    });
    await screen.findByRole("button", { name: m.result.save });
    const select = screen.getByLabelText(m.form.caseLabel);
    await screen.findByRole("option", { name: "State v. Aslam" });
    fireEvent.change(select, { target: { value: CASE } });
    fireEvent.click(screen.getByRole("button", { name: m.result.save }));

    expect(await screen.findByText("Saved to State v. Aslam")).toBeTruthy();
    expect(calls("PATCH", `/lint-reports/${REPORT}`)[0]!.body).toEqual({ caseId: CASE });
    expect(calls("POST", "/lint-reports")).toHaveLength(0);
    expect(calls("DELETE", `/lint-reports/${REPORT}`)).toHaveLength(0);
  });

  it("lists past reports, opens one and deletes one after asking", async () => {
    let items = [summaryOf(report())];
    const { calls } = await renderScreen((seen) => {
      if (seen.method === "GET" && seen.path === `/lint-reports/${REPORT}`) return json(report());
      if (seen.method === "DELETE" && seen.path === `/lint-reports/${REPORT}`) {
        items = [];
        return new Response(null, { status: 204 });
      }
      return reports(items)(seen);
    });
    const list = await screen.findByRole("list", { name: m.past.title });
    fireEvent.click(within(list).getByRole("button", { name: /^Bail application, 2026-11-21/ }));
    expect((await screen.findByLabelText(m.result.textTitle, { selector: "pre" })).textContent).toMatch(
      "IN THE COURT OF SESSIONS JUDGE",
    );

    fireEvent.click(within(list).getByRole("button", { name: `${m.past.delete}: Bail application, 2026-11-21` }));
    fireEvent.click(await screen.findByRole("button", { name: m.past.delete }));
    await waitFor(() => expect(calls("DELETE", `/lint-reports/${REPORT}`)).toHaveLength(1));
    expect(await screen.findByText(m.past.empty)).toBeTruthy();
    // The open report was the deleted one, so the form is back.
    expect(textArea()).toBeTruthy();
  });

  it("says when a report from the URL is gone", async () => {
    nav.search = `?report=${REPORT}`;
    await renderScreen(reports());
    expect(await screen.findByText(m.report.missing)).toBeTruthy();
  });

  it("renders in Urdu, keeping the English findings left to right", async () => {
    nav.search = `?report=${REPORT}`;
    await renderScreen(
      (seen) => (seen.path === `/lint-reports/${REPORT}` ? json(report()) : reports()(seen)),
      ur as unknown as typeof en,
    );
    expect(await screen.findAllByText(ur.Linter.result.noSource)).toHaveLength(2);
    expect((screen.getByText("Could not find the FIR number.")).getAttribute("dir")).toBe("ltr");
  });
});

describe("the case dashboard's lint reports card (FR-CASE-4)", () => {
  const renderCard = (route: Route, archived = false) =>
    renderWith(async () => {
      const { CaseLintReports } = await import("@/components/linter/case-lint-reports");
      return <CaseLintReports caseId={CASE} archived={archived} />;
    }, route);

  it("lists the case's reports, each opening on the linter", async () => {
    const { calls } = await renderCard(reports([summaryOf(report({ caseId: CASE }))]));
    const link = await screen.findByRole("link", { name: /Bail application, 2026-11-21/ });
    expect((link).getAttribute("href")).toBe(`/linter?report=${REPORT}`);
    expect(calls("GET", "/lint-reports")[0]!.query.get("caseId")).toBe(CASE);
    expect((screen.getByRole("link", { name: m.card.lint })).getAttribute("href")).toBe(`/linter?case=${CASE}`,);
  });

  it("an empty case says so; an archived one offers no new lint", async () => {
    await renderCard(reports(), true);
    expect(await screen.findByText(m.card.empty)).toBeTruthy();
    expect(screen.queryByRole("link", { name: m.card.lint })).toBeNull();
  });
});
