import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

// The Radix switch measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const m = en.Precedents;
const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";
const J3 = "33333333-3333-4333-8333-333333333333";
const CRPC = "44444444-4444-4444-8444-444444444444";
const EDGE = "55555555-5555-4555-8555-555555555555";
const EDGE2 = "66666666-6666-4666-8666-666666666666";
const REQ = "77777777-7777-4777-8777-777777777777";

const retrieved = {
  sourceId: J1,
  title: "Zephyr (Applicant) VS The State",
  citation: "2020 SCMR 100",
  court: "Sindh High Court",
  decidedOn: "2020-03-01",
  origin: "retrieved",
  via: null,
  flags: [],
  locator: "para 4",
  snippet: "Bail under section 497 Cr.P.C. is granted where the case calls for further inquiry.",
  score: 1,
};
const cited = {
  sourceId: J2,
  title: "Older (Appellant) VS The State",
  citation: "PLD 2019 SC 50",
  court: "Supreme Court of Pakistan",
  decidedOn: "2019-01-10",
  origin: "graph_derived",
  via: { edgeId: EDGE, type: "CITES_JUDGMENT", relatedSourceId: J1, sectionLabel: null },
  flags: ["overruled"],
  locator: null,
  snippet: null,
  score: 0.66,
};
const sibling = {
  ...cited,
  sourceId: J3,
  title: "Sibling (Applicant) VS The State",
  citation: "2023 YLR 11",
  via: { edgeId: EDGE2, type: "CITES_SECTION", relatedSourceId: J1, sectionLabel: "s.497 CrPC" },
  flags: [],
  score: 0.33,
};

const relationships = {
  sourceId: J1,
  items: [
    {
      id: EDGE,
      type: "CITES_JUDGMENT",
      direction: "outgoing",
      other: { entityType: "judgment", sourceId: J2, label: "PLD 2019 SC 50" },
      provenance: {
        documentId: J1,
        extractionMethod: "regex",
        confidence: 0.7,
        humanConfirmed: false,
      },
      verificationStatus: "unverified",
      validFrom: "2020-03-01",
      validTo: null,
      recordedAt: "2026-11-21T10:00:00Z",
    },
    {
      id: EDGE2,
      type: "CITES_SECTION",
      direction: "outgoing",
      other: { entityType: "section", sourceId: CRPC, label: "s.497 CrPC" },
      provenance: {
        documentId: J1,
        extractionMethod: "metadata",
        confidence: 0.9,
        humanConfirmed: true,
      },
      verificationStatus: "verified",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-11-21T10:00:00Z",
    },
    {
      id: "88888888-8888-4888-8888-888888888888",
      type: "CITES_JUDGMENT",
      direction: "incoming",
      other: { entityType: "judgment", sourceId: null, label: "2018 YLR 77" },
      provenance: {
        documentId: null,
        extractionMethod: "human",
        confidence: 1,
        humanConfirmed: true,
      },
      verificationStatus: "needs_review",
      validFrom: null,
      validTo: null,
      recordedAt: "2026-11-21T10:00:00Z",
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Seen = { method: string; path: string; body: unknown };
type Route = (seen: Seen) => Response | undefined;

async function renderSearch(route: Route) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const text = request.method === "GET" ? "" : await request.text();
      const entry = {
        method: request.method,
        path: new URL(request.url).pathname.replace("/api/v1", ""),
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      return route(entry) ?? problem(404);
    }),
  );
  vi.resetModules();
  const { PrecedentSearch } = await import("@/components/precedents/precedent-search");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Karachi">
        <PrecedentSearch />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return seen;
}

const result = (hits: unknown[], graphAvailable = true) =>
  json({ requestId: REQ, hits, graphAvailable });

function searchFor(query: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: m.search.label }), {
    target: { value: query },
  });
  fireEvent.click(screen.getByRole("button", { name: m.search.submit }));
}

const hitsList = () => screen.findByRole("list", { name: m.results.label });
const hitOf = (list: HTMLElement, id: string) =>
  list.querySelector(`[data-hit="${id}"]`) as HTMLElement;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Precedent search (FR-PREC-1)", () => {
  it("sends the query, only the filters that are filled in, and the graph toggle", async () => {
    const seen = await renderSearch(({ path }) =>
      path === "/precedents/search" ? result([retrieved]) : undefined,
    );
    fireEvent.change(screen.getByLabelText(m.search.court), {
      target: { value: "Sindh High Court" },
    });
    fireEvent.change(screen.getByLabelText(m.search.sectionRef), {
      target: { value: " s.497 CrPC " },
    });
    fireEvent.click(screen.getByRole("switch"));
    searchFor("  bail on further inquiry ");
    await hitsList();
    expect(seen.filter((s) => s.path === "/precedents/search").map((s) => s.body)).toEqual([
      {
        query: "bail on further inquiry",
        filters: { court: "Sindh High Court", sectionRef: "s.497 CrPC" },
        includeGraphDerived: false,
        limit: 20,
      },
    ]);
  });

  it("labels each hit by origin, with the edge and the hit it came from (FR-PREC-3)", async () => {
    await renderSearch(({ path }) =>
      path === "/precedents/search" ? result([retrieved, cited, sibling]) : undefined,
    );
    searchFor("bail");
    const list = await hitsList();
    const first = hitOf(list, J1);
    expect(first.querySelector("span[data-origin='retrieved']")!.textContent).toBe(
      m.origin.retrieved,
    );
    expect(within(first).getByText("2020 SCMR 100")).toBeTruthy();
    expect(within(first).getByText(retrieved.snippet)).toBeTruthy();
    expect(within(first).getByText("At para 4")).toBeTruthy();

    const derived = hitOf(list, J2).querySelector("span[data-origin='graph_derived']")!;
    expect(derived.getAttribute("data-edge")).toBe("CITES_JUDGMENT");
    expect(derived.textContent).toBe(
      "Graph-derived via Cites judgment from Zephyr (Applicant) VS The State",
    );
    const shared = hitOf(list, J3).querySelector("span[data-origin='graph_derived']")!;
    expect(shared.textContent).toBe(
      "Graph-derived via Cites section s.497 CrPC from Zephyr (Applicant) VS The State",
    );
  });

  it("shows flags exactly as research does (FR-TRUST-10)", async () => {
    await renderSearch(({ path }) =>
      path === "/precedents/search" ? result([retrieved, cited]) : undefined,
    );
    searchFor("bail");
    const list = await hitsList();
    const chip = hitOf(list, J2).querySelector("[data-flag='overruled']")!;
    expect(chip.textContent).toBe(en.Trust.flags.overruled);
    expect(chip.className).toContain("text-warning");
    expect(hitOf(list, J1).querySelector("[data-flag]")).toBeNull();
  });

  it("says when the graph isn't built", async () => {
    await renderSearch(({ path }) =>
      path === "/precedents/search" ? result([retrieved], false) : undefined,
    );
    searchFor("bail");
    expect((await screen.findByRole("status")).textContent).toContain(m.results.noGraph);
  });

  it("says when nothing matches", async () => {
    await renderSearch(({ path }) => (path === "/precedents/search" ? result([]) : undefined));
    searchFor("nothing");
    expect(await screen.findByText(m.results.empty)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    [429, m.errors.tooMany],
    [503, m.errors.unavailable],
    [400, m.errors.invalid],
  ])("explains a %i", async (status, message) => {
    await renderSearch(({ path }) => (path === "/precedents/search" ? problem(status) : undefined));
    searchFor("bail");
    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });
});

describe("Relationships panel (FR-PREC-4)", () => {
  const routes: Route = ({ method, path }) => {
    if (path === "/precedents/search") return result([retrieved, cited]);
    if (method === "GET" && path === `/precedents/${J1}/relationships`) return json(relationships);
    if (method === "GET" && path === `/precedents/${J2}/relationships`) return problem(404);
    if (method === "GET" && path === `/sources/${CRPC}`)
      return json({
        id: CRPC,
        kind: "statute",
        title: "Code of Criminal Procedure, 1898",
        officialUrl: "https://pakistancode.gov.pk/english/crpc",
        language: "en",
      });
    return undefined;
  };

  it("groups edges by direction with provenance and status", async () => {
    await renderSearch(routes);
    searchFor("bail");
    await hitsList();
    fireEvent.click(
      screen.getByRole("button", { name: `Show the relationships of ${retrieved.title}` }),
    );
    const outgoing = await screen.findByRole("region", { name: m.relationships.outgoing });
    const incoming = screen.getByRole("region", { name: m.relationships.incoming });
    expect(within(outgoing).getAllByRole("listitem")).toHaveLength(2);
    expect(within(incoming).getAllByRole("listitem")).toHaveLength(1);

    const regex = outgoing.querySelector(`[data-relationship="${EDGE}"]`) as HTMLElement;
    expect(within(regex).getByText(m.edgeTypes.CITES_JUDGMENT)).toBeTruthy();
    expect(within(regex).getByText(m.relationships.methods.regex)).toBeTruthy();
    expect(within(regex).getByText("70%")).toBeTruthy();
    expect(within(regex).getByText(m.relationships.no)).toBeTruthy();
    expect(regex.querySelector("[data-status]")!.getAttribute("data-status")).toBe("unverified");

    const human = incoming.querySelector("[data-relationship]") as HTMLElement;
    expect(within(human).getByText(m.relationships.methods.human)).toBeTruthy();
    expect(within(human).getByText(m.relationships.yes)).toBeTruthy();
    // No corpus record: shown by its label, not as a link.
    expect(within(human).queryByRole("button")).toBeNull();
    expect(within(human).getByText("2018 YLR 77")).toBeTruthy();
  });

  it("opens the source of an entity that is a corpus record", async () => {
    await renderSearch(routes);
    searchFor("bail");
    await hitsList();
    fireEvent.click(
      screen.getByRole("button", { name: `Show the relationships of ${retrieved.title}` }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open s.497 CrPC" }));
    expect(await screen.findByText("Code of Criminal Procedure, 1898")).toBeTruthy();
    const link = screen.getByRole("link", { name: m.source.official });
    expect(link.getAttribute("href")).toBe("https://pakistancode.gov.pk/english/crpc");
    fireEvent.click(screen.getByRole("button", { name: m.source.back }));
    expect(await screen.findByRole("region", { name: m.relationships.outgoing })).toBeTruthy();
  });

  it("words a 404 as not in the corpus", async () => {
    await renderSearch(routes);
    searchFor("bail");
    await hitsList();
    fireEvent.click(
      screen.getByRole("button", { name: `Show the relationships of ${cited.title}` }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(m.relationships.notFound),
    );
  });
});
