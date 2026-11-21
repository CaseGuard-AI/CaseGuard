import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

const nav = vi.hoisted(() => ({ push: vi.fn(), search: "" }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn() }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

const m = en.Drafting;
const CASE = "00000000-0000-4000-8000-0000000000a1";
const DRAFT = "00000000-0000-4000-8000-0000000000d1";
const CIT = "00000000-0000-4000-8000-0000000000c1";
const SOURCE = "00000000-0000-4000-8000-0000000000e1";
const AT = "2026-11-20T10:00:00Z";
const NOW = new Date("2026-11-21T12:00:00Z");

const BAIL = {
  id: "bail_application",
  version: "1",
  title: "Bail application (s.497/498 CrPC)",
  description: "Bail after or before arrest.",
  fields: [
    { key: "court", label: "Court", required: true, caseField: "court" },
    { key: "fir_number", label: "FIR number and date", required: true, caseField: null },
  ],
  sections: [
    {
      key: "cause_title",
      heading: "Cause title",
      required: true,
      assistable: false,
      guidance: "The court and the parties.",
    },
    {
      key: "grounds",
      heading: "Grounds for bail",
      required: true,
      assistable: true,
      guidance: "Numbered grounds under s.497(2).",
    },
  ],
};
const PLAINT = { ...BAIL, id: "plaint", title: "Plaint (Order VII CPC)", description: "A suit." };

const citation = (status: "verified" | "needs_review" | "unverified") => ({
  id: CIT,
  sourceId: SOURCE,
  claim: "Bail is the rule.",
  locator: "s. 497",
  verification: { status, flags: [], lastVerifiedAt: "2026-11-01T00:00:00Z" },
});

type Draft = {
  id: string;
  templateId: string;
  templateVersion: string;
  title: string;
  caseId: string | null;
  fields: Record<string, string | null>;
  sections: { key: string; body: string }[];
  citations: ReturnType<typeof citation>[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

const draft = (extra: Partial<Draft> = {}): Draft => ({
  id: DRAFT,
  templateId: "bail_application",
  templateVersion: "1",
  title: "Bail for Ahmed",
  caseId: null,
  fields: { court: "Sindh High Court", fir_number: null },
  sections: [
    { key: "cause_title", body: "" },
    { key: "grounds", body: "" },
  ],
  citations: [],
  version: 1,
  createdAt: AT,
  updatedAt: AT,
  ...extra,
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

// Templates, cases and citations every screen asks for; `route` answers the rest first.
const common: Route = ({ method, path }) => {
  if (method === "GET" && path === "/drafting/templates") return json({ items: [BAIL, PLAINT] });
  if (method === "GET" && path === "/cases") return json({ items: [], nextCursor: null });
  if (method === "GET" && path.startsWith("/citations/")) return problem(404);
  if (method === "GET" && path.startsWith("/sources/")) return problem(404);
  return undefined;
};

async function renderWith(load: () => Promise<ReactElement>, route: Route) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const request = input as Request;
      const url = new URL(request.url);
      const text = request.method === "GET" ? "" : await request.text();
      const entry = {
        method: request.method,
        path: url.pathname.replace("/api/v1", ""),
        query: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
      };
      seen.push(entry);
      return (await route(entry)) ?? (await common(entry)) ?? problem(404);
    }),
  );
  vi.resetModules();
  const element = await load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Karachi" now={NOW}>
        {element}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return {
    calls: (method: string, path: string) =>
      seen.filter((s) => s.method === method && s.path === path),
  };
}

const renderEditor = (route: Route) =>
  renderWith(async () => {
    const { DraftEditor } = await import("@/components/drafting/draft-editor");
    return <DraftEditor draftId={DRAFT} />;
  }, route);

beforeEach(() => {
  nav.push.mockReset();
  nav.search = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("new draft (FR-DRAFT-1, FR-DRAFT-2)", () => {
  const renderNew = (route: Route) =>
    renderWith(async () => {
      const { NewDraft } = await import("@/components/drafting/new-draft");
      return <NewDraft />;
    }, route);

  it("creates a draft from the chosen template and opens it", async () => {
    const { calls } = await renderNew(({ method, path }) =>
      method === "POST" && path === "/drafts" ? json(draft(), 201) : undefined,
    );
    const create = screen.getByRole("button", { name: m.new.create });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("radio", { name: /Plaint \(Order VII CPC\)/ }));
    fireEvent.click(create);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/drafting/${DRAFT}`));
    expect(calls("POST", "/drafts")[0]!.body).toEqual({ templateId: "plaint" });
  });

  it("preselects the case from ?case= and sends it", async () => {
    nav.search = `case=${CASE}`;
    const { calls } = await renderNew(({ method, path }) => {
      if (method === "POST" && path === "/drafts") return json(draft({ caseId: CASE }), 201);
      if (method === "GET" && path === `/cases/${CASE}`)
        return json({
          id: CASE,
          title: "State v. Ahmed",
          archivedAt: null,
          createdAt: AT,
          updatedAt: AT,
        });
      return undefined;
    });
    fireEvent.click(await screen.findByRole("radio", { name: /Bail application/ }));
    fireEvent.click(screen.getByRole("button", { name: m.new.create }));
    await waitFor(() => expect(calls("POST", "/drafts")).toHaveLength(1));
    expect(calls("POST", "/drafts")[0]!.body).toEqual({
      templateId: "bail_application",
      caseId: CASE,
    });
  });

  it("explains a case the API refused", async () => {
    nav.search = `case=${CASE}`;
    await renderNew(({ method, path }) =>
      method === "POST" && path === "/drafts"
        ? problem(400, { errors: [{ path: "caseId", message: "That case is archived" }] })
        : undefined,
    );
    fireEvent.click(await screen.findByRole("radio", { name: /Bail application/ }));
    fireEvent.click(screen.getByRole("button", { name: m.new.create }));
    expect((await screen.findByRole("alert")).textContent).toContain(m.new.caseUnavailable);
  });
});

describe("editor (FR-DRAFT-3, FR-DRAFT-4)", () => {
  it("shows the fields and the sections in template order, each with its guidance", async () => {
    await renderEditor(({ method, path }) =>
      method === "GET" && path === `/drafts/${DRAFT}` ? json(draft()) : undefined,
    );
    expect(((await screen.findByLabelText(/Court/)) as HTMLInputElement).value).toBe(
      "Sindh High Court",
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.indexOf("Cause title (required)")).toBeLessThan(
      headings.indexOf("Grounds for bail (required)"),
    );
    expect(screen.getByText("Numbered grounds under s.497(2).")).toBeTruthy();
    expect(screen.getByLabelText("Grounds for bail").tagName).toBe("TEXTAREA");
    // Only assistable sections get Assist.
    expect(screen.getAllByRole("button", { name: m.assist.open })).toHaveLength(1);
  });

  it("assist shows the suggestion with the stored status, and Insert puts it in the section (FR-TRUST-10)", async () => {
    const { calls } = await renderEditor(({ method, path }) => {
      if (method === "GET" && path === `/drafts/${DRAFT}`) return json(draft());
      if (method === "POST" && path === `/drafts/${DRAFT}/sections/grounds/assist`)
        return json({
          sectionKey: "grounds",
          text: `1. That bail is the rule [[c:${CIT}]].`,
          citations: [citation("needs_review")],
        });
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: m.assist.open }));
    fireEvent.change(screen.getByLabelText(m.assist.instruction), {
      target: { value: "First offender" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.assist.run }));
    const region = await screen.findByRole("region", { name: /Grounds for bail/ });
    const chips = await within(region).findAllByRole("button", {
      name: "Citation 1: Needs review",
    });
    expect(chips.every((c) => c.dataset.status === "needs_review")).toBe(true);
    expect(calls("POST", `/drafts/${DRAFT}/sections/grounds/assist`)[0]!.body).toEqual({
      instruction: "First offender",
    });
    fireEvent.click(within(region).getByRole("button", { name: m.assist.insert }));
    expect((screen.getByLabelText("Grounds for bail") as HTMLInputElement).value).toBe(
      `1. That bail is the rule [[c:${CIT}]].`,
    );
    // The section now lists the citation with the same status.
    expect(
      within(screen.getByRole("list", { name: "Citations in Grounds for bail" })).getByRole(
        "button",
        { name: "Citation 1: Needs review" },
      ),
    ).toBeTruthy();
  });

  it("explains an assist that AI access refused", async () => {
    await renderEditor(({ method, path }) => {
      if (method === "GET" && path === `/drafts/${DRAFT}`) return json(draft());
      if (method === "POST" && path.endsWith("/assist")) return problem(403);
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: m.assist.open }));
    fireEvent.click(screen.getByRole("button", { name: m.assist.run }));
    expect((await screen.findByRole("alert")).textContent).toContain(m.assist.errors.aiDisabled);
  });

  it("saves with the loaded version and moves to the next one", async () => {
    const { calls } = await renderEditor(({ method, path, body }) => {
      if (method === "GET" && path === `/drafts/${DRAFT}`) return json(draft());
      if (method === "PUT" && path === `/drafts/${DRAFT}`) {
        const sent = body as Draft;
        return json(draft({ ...sent, version: sent.version + 1 }));
      }
      return undefined;
    });
    const save = await screen.findByRole("button", { name: m.editor.saved });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Grounds for bail"), { target: { value: "1. Bail." } });
    fireEvent.click(screen.getByRole("button", { name: m.editor.save }));
    await screen.findByRole("button", { name: m.editor.saved });
    fireEvent.change(screen.getByLabelText("Grounds for bail"), { target: { value: "2. More." } });
    fireEvent.click(screen.getByRole("button", { name: m.editor.save }));
    await waitFor(() => expect(calls("PUT", `/drafts/${DRAFT}`)).toHaveLength(2));
    const [first, second] = calls("PUT", `/drafts/${DRAFT}`);
    expect(first!.body).toMatchObject({
      version: 1,
      sections: [
        { key: "cause_title", body: "" },
        { key: "grounds", body: "1. Bail." },
      ],
    });
    expect((second!.body as Draft).version).toBe(2);
  });

  it("a 409 offers a reload, which loads the saved draft", async () => {
    let saved = draft();
    await renderEditor(({ method, path }) => {
      if (method === "GET" && path === `/drafts/${DRAFT}`) return json(saved);
      if (method === "PUT" && path === `/drafts/${DRAFT}`) return problem(409);
      return undefined;
    });
    fireEvent.change(await screen.findByLabelText("Grounds for bail"), {
      target: { value: "Mine" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.editor.save }));
    expect((await screen.findByRole("alert")).textContent).toContain(m.editor.conflict);
    saved = draft({
      version: 2,
      sections: [
        { key: "cause_title", body: "" },
        { key: "grounds", body: "Theirs" },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: m.editor.reload }));
    await waitFor(() =>
      expect((screen.getByLabelText("Grounds for bail") as HTMLInputElement).value).toBe("Theirs"),
    );
    expect(screen.queryByText(m.editor.conflict)).toBeNull();
  });

  it("exports through the API as a file", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const { calls } = await renderEditor(({ method, path }) => {
      if (method === "GET" && path === `/drafts/${DRAFT}`) return json(draft());
      if (method === "GET" && path === `/drafts/${DRAFT}/export`)
        return new Response("%PDF", { headers: { "Content-Type": "application/pdf" } });
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: m.editor.exportPdf }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(calls("GET", `/drafts/${DRAFT}/export`)[0]!.query.get("format")).toBe("pdf");
  });

  it("deletes only after confirming, then goes back to the list", async () => {
    const { calls } = await renderEditor(({ method, path }) => {
      if (method === "GET" && path === `/drafts/${DRAFT}`) return json(draft());
      if (method === "DELETE" && path === `/drafts/${DRAFT}`)
        return new Response(null, { status: 204 });
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: m.editor.delete }));
    expect(calls("DELETE", `/drafts/${DRAFT}`)).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: m.editor.deleteConfirm }));
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/drafting"));
    expect(calls("DELETE", `/drafts/${DRAFT}`)).toHaveLength(1);
  });

  it("another user's or a missing draft says so", async () => {
    await renderEditor(() => undefined);
    expect((await screen.findByRole("alert")).textContent).toContain(m.editor.notFound);
  });
});

describe("case dashboard drafts card (FR-CASE-4)", () => {
  it("lists the case's drafts and links a new one to the case", async () => {
    const { calls } = await renderWith(
      async () => {
        const { CaseDrafts } = await import("@/components/drafting/case-drafts");
        return <CaseDrafts caseId={CASE} archived={false} />;
      },
      ({ method, path }) =>
        method === "GET" && path === "/drafts"
          ? json({
              items: [
                {
                  id: DRAFT,
                  templateId: "bail_application",
                  title: "Bail for Ahmed",
                  caseId: CASE,
                  version: 3,
                  updatedAt: AT,
                },
              ],
              nextCursor: null,
            })
          : undefined,
    );
    const link = await screen.findByRole("link", { name: "Bail for Ahmed" });
    expect(link.getAttribute("href")).toBe(`/drafting/${DRAFT}`);
    expect(calls("GET", "/drafts")[0]!.query.get("caseId")).toBe(CASE);
    expect(screen.getByRole("link", { name: m.card.new }).getAttribute("href")).toBe(
      `/drafting?case=${CASE}`,
    );
  });

  it("an archived case gets no new-draft link", async () => {
    await renderWith(
      async () => {
        const { CaseDrafts } = await import("@/components/drafting/case-drafts");
        return <CaseDrafts caseId={CASE} archived />;
      },
      ({ path }) => (path === "/drafts" ? json({ items: [], nextCursor: null }) : undefined),
    );
    expect(await screen.findByText(m.list.emptyCase)).toBeTruthy();
    expect(screen.queryByRole("link", { name: m.card.new })).toBeNull();
  });
});
