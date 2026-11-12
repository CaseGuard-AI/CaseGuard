import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ur from "../messages/ur.json";

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: "" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const CONV = "00000000-0000-4000-8000-0000000000c1";
const C1 = "00000000-0000-4000-8000-0000000000a1";
const C2 = "00000000-0000-4000-8000-0000000000a2";
const S1 = "00000000-0000-4000-8000-0000000000b1";
const S2 = "00000000-0000-4000-8000-0000000000b2";
const UNKNOWN = "00000000-0000-4000-8000-0000000000ff";

const verification = (status: string, flags: string[] = []) => ({
  status,
  flags,
  lastVerifiedAt: "2026-09-12T10:00:00Z",
});

const citations = [
  {
    id: C1,
    sourceId: S1,
    claim: "A fair hearing is part of due process.",
    locator: "Art. 10A",
    quote: "منصفانہ سماعت کا حق",
    quoteLanguage: "ur",
    verification: verification("verified"),
  },
  {
    id: C2,
    sourceId: S2,
    claim: "The notice must disclose the case.",
    locator: "para 14",
    quote: "A person must be afforded a fair opportunity.",
    quoteLanguage: "en",
    verification: verification("needs_review", ["overruled", "stale"]),
  },
];

const answer = {
  id: "00000000-0000-4000-8000-0000000000d1",
  role: "assistant",
  text: `Yes [[c:${C1}]].\n\nThe notice must disclose the case [[c:${C2}]] [[c:${UNKNOWN}]].`,
  language: "en",
  answerable: true,
  citations,
  createdAt: "2026-10-21T12:00:00Z",
};

const sources: Record<string, object> = {
  [S1]: {
    id: S1,
    kind: "statute",
    title: "Constitution of Pakistan",
    officialUrl: "https://pakistancode.gov.pk/constitution",
    language: "en",
    sourceTier: 1,
  },
  [S2]: {
    id: S2,
    kind: "judgment",
    title: "Example v. Federation",
    citation: "PLD 2022 SC 123",
    court: "Supreme Court of Pakistan",
    officialUrl: "javascript:alert(1)",
    language: "en",
    thirdParty: true,
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

type Route = (method: string, path: string) => Response | undefined;

// Answers each request from `route`. Citation and source lookups fall back to the fixtures.
async function renderHub(route: Route = () => undefined) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname.replace("/api/v1", "");
    const routed = route(request.method, path);
    if (routed) return routed;
    const citation = citations.find((c) => path === `/citations/${c.id}`);
    if (citation) return json(citation);
    const source = Object.keys(sources).find((id) => path === `/sources/${id}`);
    if (source) return json(sources[source]);
    return problem(404);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { ResearchHub } = await import("@/components/research/research-hub");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="ur" messages={ur} timeZone="Asia/Karachi">
        <ResearchHub />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const askRoutes: Route = (method, path) => {
  if (method === "POST" && path === "/conversations")
    return json(
      {
        id: CONV,
        title: "",
        createdAt: answer.createdAt,
        updatedAt: answer.createdAt,
        messages: [],
      },
      201,
    );
  if (method === "POST" && path === `/conversations/${CONV}/messages`) return json(answer, 201);
};

function ask(question = "Can an order be challenged without a hearing?") {
  fireEvent.change(screen.getByLabelText(ur.Research.placeholder), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: ur.Research.submit }));
}

const chip = (n: number) =>
  screen.getByRole("button", {
    name: new RegExp(`^${ur.Trust.chip.replace("{n}", String(n)).replace(": {status}", "")}`),
  });

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

describe("ResearchHub", () => {
  it("starts a conversation, asks, and keeps its id in the URL", async () => {
    const fetchMock = await renderHub(askRoutes);
    ask();
    await screen.findByText(ur.Research.analysis);
    const calls = fetchMock.mock.calls.map(([r]) => [
      (r as Request).method,
      new URL((r as Request).url).pathname,
    ]);
    expect(calls.slice(0, 2)).toEqual([
      ["POST", "/api/v1/conversations"],
      ["POST", `/api/v1/conversations/${CONV}/messages`],
    ]);
    const asked = fetchMock.mock.calls[1][0] as Request;
    expect(await asked.json()).toEqual({
      question: "Can an order be challenged without a hearing?",
    });
    expect(nav.replace).toHaveBeenCalledWith(`/research?c=${CONV}`);
    expect(screen.getByText("Can an order be challenged without a hearing?")).toBeTruthy();
    expect(screen.queryByText(ur.Research.asOfNote)).toBeNull(); // no date, no note
  });

  it("renders chips in order with their stored status and drops unknown markers", async () => {
    await renderHub(askRoutes);
    ask();
    await screen.findByText(ur.Research.analysis);
    expect(chip(1).getAttribute("aria-label")).toBe(`حوالہ 1: ${ur.Trust.verified}`);
    expect(chip(2).getAttribute("aria-label")).toBe(`حوالہ 2: ${ur.Trust.needs_review}`);
    const article = screen.getByRole("article");
    expect(within(article).getAllByRole("button")).toHaveLength(2);
    expect(article.textContent).not.toContain(UNKNOWN);
    expect(within(article).getByText(/Yes/).closest("[dir]")?.getAttribute("dir")).toBe("ltr");
  });

  it("opens the source panel with the quote in its own language and a safe official link", async () => {
    await renderHub(askRoutes);
    ask();
    await screen.findByText(ur.Research.analysis);
    fireEvent.click(chip(1));
    const panel = await screen.findByRole("dialog");
    const quote = within(panel).getByText("منصفانہ سماعت کا حق");
    expect(quote.getAttribute("lang")).toBe("ur");
    expect(quote.getAttribute("dir")).toBe("rtl");
    expect(within(panel).getByText(/آخری تصدیق/)).toBeTruthy();
    const link = await within(panel).findByRole("link", { name: ur.Research.source.openOfficial });
    expect(link.getAttribute("href")).toBe("https://pakistancode.gov.pk/constitution");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(panel).getByRole("button", { name: ur.Common.close })).toBeTruthy();
  });

  it("shows flags and never links a javascript: official URL", async () => {
    await renderHub(askRoutes);
    ask();
    await screen.findByText(ur.Research.analysis);
    fireEvent.click(chip(2));
    const panel = await screen.findByRole("dialog");
    await within(panel).findByText("Example v. Federation");
    expect(within(panel).getByText(ur.Trust.flags.overruled)).toBeTruthy();
    expect(within(panel).getByText(ur.Trust.flags.stale)).toBeTruthy();
    expect(within(panel).getByText(ur.Research.source.thirdParty)).toBeTruthy();
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("shows the current stored status everywhere once the citation lookup returns (FR-TRUST-10)", async () => {
    await renderHub((method, path) => {
      if (path === `/citations/${C1}`)
        return json({
          ...citations[0],
          verification: verification("needs_review", ["amended_since"]),
        });
      return askRoutes(method, path);
    });
    ask();
    await screen.findByText(ur.Research.analysis);
    await waitFor(() => expect(chip(1).getAttribute("data-status")).toBe("needs_review"));
    const list = screen.getByRole("region", { name: ur.Research.sources });
    const badges = list.querySelectorAll("[data-status]");
    expect([...badges].map((b) => b.getAttribute("data-status"))).toEqual([
      "needs_review",
      "needs_review",
    ]);
    fireEvent.click(chip(1));
    const panel = await screen.findByRole("dialog");
    expect(panel.querySelector("[data-status]")?.getAttribute("data-status")).toBe("needs_review");
    expect(within(panel).getByText(ur.Trust.flags.amended_since)).toBeTruthy();
  });

  it("keeps the saved status when the citation lookup fails", async () => {
    await renderHub((method, path) =>
      path.startsWith("/citations/") ? problem(503) : askRoutes(method, path),
    );
    ask();
    await screen.findByText(ur.Research.analysis);
    await new Promise((r) => setTimeout(r, 50));
    expect(chip(1).getAttribute("data-status")).toBe("verified");
  });

  it("says when the sources don't support an answer", async () => {
    await renderHub((method, path) => {
      if (path === `/conversations/${CONV}/messages`)
        return json(
          { ...answer, text: "No answer in the corpus.", answerable: false, citations: [] },
          201,
        );
      return askRoutes(method, path);
    });
    ask();
    expect((await screen.findByRole("note")).textContent).toContain(ur.Research.unanswerable);
    expect(screen.queryByRole("region", { name: ur.Research.sources })).toBeNull();
  });

  it.each([
    [403, ur.Research.errors.aiDisabled],
    [429, ur.Research.errors.tooMany],
    [503, ur.Research.errors.unavailable],
  ])("explains a %s from the ask", async (status, message) => {
    await renderHub((method, path) =>
      path.endsWith("/messages") ? problem(status) : askRoutes(method, path),
    );
    ask();
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(screen.getByLabelText<HTMLTextAreaElement>(ur.Research.placeholder).value).not.toBe("");
  });

  it("sends the law-as-of date and shows the note that comes back (FR-RES-11)", async () => {
    const note = "Law as of 2020-01-01: judgments decided after this date were left out.";
    const fetchMock = await renderHub((method, path) =>
      method === "POST" && path === `/conversations/${CONV}/messages`
        ? json({ ...answer, asOfNote: note }, 201)
        : askRoutes(method, path),
    );
    const date = screen.getByLabelText(ur.Research.lawAsOf) as HTMLInputElement;
    expect(date.type).toBe("date");
    expect(date.value).toBe("");
    expect(date.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    fireEvent.change(date, { target: { value: "2020-01-01" } });
    ask();
    const shown = await screen.findByText(note);
    expect(shown.closest('[role="note"]')).toBeTruthy();
    expect(screen.getByText(ur.Research.asOfNote)).toBeTruthy();
    const asked = fetchMock.mock.calls[1][0] as Request;
    expect(await asked.json()).toEqual({
      question: "Can an order be challenged without a hearing?",
      lawAsOf: "2020-01-01",
    });
  });

  it("retries in the same conversation after a failed ask", async () => {
    let fail = true;
    const fetchMock = await renderHub((method, path) => {
      if (path.endsWith("/messages") && fail) return problem(503);
      return askRoutes(method, path);
    });
    ask();
    await screen.findByRole("alert");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: ur.Research.submit }));
    await screen.findByText(ur.Research.analysis);
    const creates = fetchMock.mock.calls.filter(
      ([r]) => new URL((r as Request).url).pathname === "/api/v1/conversations",
    );
    expect(creates).toHaveLength(1);
  });

  it("restores the thread from ?c= and clears an unknown one", async () => {
    nav.search = `c=${CONV}`;
    await renderHub((method, path) =>
      method === "GET" && path === `/conversations/${CONV}`
        ? json({
            id: CONV,
            title: "t",
            createdAt: answer.createdAt,
            updatedAt: answer.createdAt,
            messages: [
              { id: "u1", role: "user", text: "Earlier question", createdAt: answer.createdAt },
              answer,
            ],
          })
        : undefined,
    );
    expect(await screen.findByText("Earlier question")).toBeTruthy();
    expect(chip(1)).toBeTruthy();
    cleanup();

    nav.search = `c=${UNKNOWN}`;
    await renderHub();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/research"));
  });
});
