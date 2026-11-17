import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const m = ur.Cases.research;
const CASE = "00000000-0000-4000-8000-0000000000a1";
const OLD = "00000000-0000-4000-8000-0000000000a3";
const CONV = "00000000-0000-4000-8000-0000000000c1";
const AT = "2026-11-18T11:00:00Z";

const legalCase = (id: string, title: string, archivedAt: string | null = null) => ({
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
  createdAt: AT,
  updatedAt: AT,
  archivedAt,
});
const cases = {
  [CASE]: legalCase(CASE, "State v. Ahmed"),
  [OLD]: legalCase(OLD, "Closed matter", AT),
};

const answer = {
  id: "00000000-0000-4000-8000-0000000000d1",
  role: "assistant",
  text: "No answer in the corpus.",
  language: "en",
  answerable: false,
  citations: [],
  createdAt: AT,
};
const summary = (caseId: string | null) => ({
  id: CONV,
  title: "Bail question",
  caseId,
  createdAt: AT,
  updatedAt: AT,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number) => json({ type: "about:blank", title: "Error", status }, status);

// A server with two cases (one archived) and one conversation whose case can be changed.
async function renderHub() {
  let conversationCase: string | null = null;
  const sent: { method: string; path: string; body: unknown }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname.replace("/api/v1", "");
    const text = request.method === "GET" ? "" : await request.text();
    const body = text ? JSON.parse(text) : undefined;
    if (request.method !== "GET") sent.push({ method: request.method, path, body });
    if (request.method === "GET") {
      if (path === "/conversations") return json({ items: [], nextCursor: null });
      if (path === "/cases") return json({ items: [cases[CASE]], nextCursor: null });
      const found = Object.values(cases).find((c) => path === `/cases/${c.id}`);
      if (found) return json(found);
      if (path === `/conversations/${CONV}`)
        return json({ ...summary(conversationCase), messages: [] });
    }
    if (request.method === "POST" && path === "/conversations")
      return json({ ...summary(body?.caseId ?? null), messages: [] }, 201);
    if (request.method === "POST" && path === `/conversations/${CONV}/messages`)
      return json(answer, 201);
    if (request.method === "PATCH" && path === `/conversations/${CONV}`) {
      conversationCase = body.caseId;
      return json(summary(conversationCase));
    }
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
  return sent;
}

function ask(question = "Is bail a right here?") {
  fireEvent.change(screen.getByLabelText(ur.Research.placeholder), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: ur.Research.submit }));
}

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

describe("Asking within a case (FR-CASE-5, FR-CASE-6)", () => {
  it("starts the conversation in the case from ?case=", async () => {
    nav.search = `case=${CASE}`;
    const sent = await renderHub();
    expect(await screen.findByRole("link", { name: cases[CASE].title })).toBeTruthy();
    ask();
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith(`/research?c=${CONV}`));
    expect(sent[0]).toEqual({ method: "POST", path: "/conversations", body: { caseId: CASE } });
  });

  it("asks without a case when the one in ?case= is archived, and says so", async () => {
    nav.search = `case=${OLD}`;
    const sent = await renderHub();
    expect(await screen.findByText(m.unavailable)).toBeTruthy();
    ask();
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    expect(sent[0]).toEqual({ method: "POST", path: "/conversations", body: {} });
  });

  it("lets the case be dropped before asking", async () => {
    nav.search = `case=${CASE}`;
    await renderHub();
    fireEvent.click(await screen.findByRole("button", { name: m.clear }));
    expect(nav.replace).toHaveBeenCalledWith("/research");
  });

  it("saves an open conversation to a case and detaches it again", async () => {
    nav.search = `c=${CONV}`;
    const sent = await renderHub();
    const select = (await screen.findByLabelText(m.saveLabel)) as HTMLSelectElement;
    await screen.findByRole("option", { name: cases[CASE].title });
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: CASE } });
    await waitFor(() => expect(select.value).toBe(CASE));
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { method: "PATCH", path: `/conversations/${CONV}`, body: { caseId: CASE } },
      { method: "PATCH", path: `/conversations/${CONV}`, body: { caseId: null } },
    ]);
    await waitFor(() => expect(select.value).toBe(""));
  });
});
