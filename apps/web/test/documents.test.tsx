import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  Link: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const m = en.Documents;
const CASE = "00000000-0000-4000-8000-0000000000a1";
const DOC = "00000000-0000-4000-8000-0000000000d1";
const DOC2 = "00000000-0000-4000-8000-0000000000d2";
const NOW = new Date("2026-11-19T12:00:00Z");

type Doc = {
  id: string;
  caseId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  status: "queued" | "processing" | "done" | "flagged" | "failed";
  flags: { stage: string; code: string; message: string; page: number | null }[];
  error: string | null;
  pages: number | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
};

const doc = (id: string, extra: Partial<Doc> = {}): Doc => ({
  id,
  caseId: CASE,
  filename: "FIR 112-2026.pdf",
  mediaType: "application/pdf",
  sizeBytes: 2_097_152,
  status: "done",
  flags: [],
  error: null,
  pages: 4,
  createdAt: "2026-11-19T11:00:00Z",
  updatedAt: "2026-11-19T11:05:00Z",
  processedAt: "2026-11-19T11:05:00Z",
  ...extra,
});

const flag = {
  stage: "ocr",
  code: "low_ocr_confidence",
  message: "Page 3 was hard to read; check the text against the original.",
  page: 3,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": status < 400 ? "application/json" : "application/problem+json" },
  });
const problem = (status: number, extra: object = {}) =>
  json({ type: "about:blank", title: "Error", status, ...extra }, status);
const page = (items: Doc[]) => json({ items, nextCursor: null });

type Seen = { method: string; path: string; query: URLSearchParams; request: Request };
type Route = (seen: Seen) => Response | undefined | Promise<Response | undefined>;

async function renderWith(load: () => Promise<ReactElement>, route: Route) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const entry = {
      method: request.method,
      path: url.pathname.replace("/api/v1", ""),
      query: url.searchParams,
      request,
    };
    seen.push(entry);
    return (await route(entry)) ?? problem(404);
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
    seen.filter((s) => s.method === method && s.path === path);
  return { calls };
}

const renderCase = (route: Route, archived = false) =>
  renderWith(async () => {
    const { CaseDocuments } = await import("@/components/documents/case-documents");
    return <CaseDocuments caseId={CASE} archived={archived} />;
  }, route);

const fileInput = () => screen.getByLabelText(m.upload.choose, { selector: "input" });
const pick = (file: File) => fireEvent.change(fileInput(), { target: { files: [file] } });
const pdf = (name = "FIR.pdf", size = 1024) => {
  const file = new File(["%PDF-1.7"], name, { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Document status (FR-DOC-3, FR-DOC-4)", () => {
  it("shows each status, and a flagged document with its flags, never as done", async () => {
    await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents")
        return page([
          doc(DOC, { status: "flagged", flags: [flag] }),
          doc(DOC2, { filename: "Plaint.docx", status: "failed", error: "The file is encrypted." }),
        ]);
    });
    const list = await screen.findByRole("list", { name: m.list.label });
    const rows = within(list).getAllByRole("listitem", { hidden: false });
    const flagged = rows.find((r) => r.getAttribute("data-document") === DOC)!;
    const badge = flagged.querySelector("[data-status]")!;
    expect(badge.getAttribute("data-status")).toBe("flagged");
    expect(badge.className).toContain("text-warning");
    expect(badge.className).not.toContain("text-success");
    expect(badge.textContent).toContain(m.status.flagged);
    expect(badge.textContent).not.toContain(m.status.done);
    expect(within(flagged).getByText(m.flaggedNote)).toBeTruthy();
    expect(within(flagged).getByText(flag.message)).toBeTruthy();
    expect(within(flagged).getByText(/OCR · Page 3/)).toBeTruthy();

    const failed = rows.find((r) => r.getAttribute("data-document") === DOC2)!;
    expect(failed.querySelector("[data-status]")!.getAttribute("data-status")).toBe("failed");
    expect(within(failed).getByText("The file is encrypted.")).toBeTruthy();
    expect(within(failed).getByRole("button", { name: m.actions.retry })).toBeTruthy();
  });

  it("offers no retry for a done document", async () => {
    await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents") return page([doc(DOC)]);
    });
    await screen.findByText("FIR 112-2026.pdf");
    expect(screen.queryByRole("button", { name: m.actions.retry })).toBeNull();
    expect(document.querySelector("[data-status]")!.getAttribute("data-status")).toBe("done");
  });

  it("polls while a document is processing and stops once it is done", async () => {
    let gets = 0;
    const { calls } = await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents") {
        gets += 1;
        return page([doc(DOC, { status: gets < 2 ? "processing" : "done" })]);
      }
    });
    await screen.findByText(m.status.processing);
    expect(await screen.findByText(m.status.done, {}, { timeout: 6_000 })).toBeTruthy();
    const settled = calls("GET", "/documents").length;
    await act(() => new Promise((resolve) => setTimeout(resolve, 3_500)));
    expect(calls("GET", "/documents").length).toBe(settled);
  }, 15_000);

  it("asks only for the case's documents", async () => {
    const { calls } = await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents") return page([]);
    });
    expect(await screen.findByText(m.list.emptyCase)).toBeTruthy();
    expect(calls("GET", "/documents")[0].query.get("caseId")).toBe(CASE);
  });
});

describe("Upload (FR-DOC-1)", () => {
  const listRoute: Route = ({ method, path }) => {
    if (method === "GET" && path === "/documents") return page([]);
  };

  it("refuses a file of the wrong type or over 25 MB before sending anything", async () => {
    const { calls } = await renderCase(listRoute);
    await screen.findByText(m.list.emptyCase);
    pick(new File(["x"], "notes.txt", { type: "text/plain" }));
    expect(await screen.findByText(m.upload.errors.type)).toBeTruthy();
    pick(pdf("big.pdf", 26_214_401));
    expect(await screen.findByText(m.upload.errors.size)).toBeTruthy();
    expect(calls("POST", `/cases/${CASE}/documents`)).toHaveLength(0);
  });

  it("sends the file as multipart to the case and says it is queued", async () => {
    // What reaches the wire depends on how jsdom's FormData crosses into Node's Request, which
    // differs between Node versions. So the test checks the FormData the code builds: one `file`
    // part with the file's name. The browser then sends it as multipart with its own boundary.
    const append = vi.spyOn(FormData.prototype, "append");
    const file = pdf();
    const { calls } = await renderCase((seen) => {
      if (seen.method === "POST" && seen.path === `/cases/${CASE}/documents`)
        return json(doc(DOC, { filename: "FIR.pdf", status: "queued", processedAt: null }), 201);
      return listRoute(seen);
    });
    await screen.findByText(m.list.emptyCase);
    pick(file);
    expect(await screen.findByText(m.upload.queued.replace("{name}", "FIR.pdf"))).toBeTruthy();
    expect(calls("POST", `/cases/${CASE}/documents`)).toHaveLength(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith("file", file, "FIR.pdf");
    append.mockRestore();
  });

  it.each([
    [413, {}, m.upload.errors.tooLarge],
    [415, {}, m.upload.errors.unsupported],
    [400, { errors: [{ path: "caseId", message: "archived" }] }, m.upload.errors.archived],
  ])("shows the server's %i answer", async (status, extra, text) => {
    await renderCase((seen) => {
      if (seen.method === "POST") return problem(status, extra);
      return listRoute(seen);
    });
    await screen.findByText(m.list.emptyCase);
    pick(pdf());
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("has no uploader in an archived case", async () => {
    await renderCase(listRoute, true);
    expect(await screen.findByText(m.card.bodyArchived)).toBeTruthy();
    expect(screen.queryByLabelText(m.upload.choose, { selector: "input" })).toBeNull();
  });
});

describe("Document actions", () => {
  it("deletes only after the confirmation", async () => {
    let gone = false;
    const { calls } = await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents") return page(gone ? [] : [doc(DOC)]);
      if (method === "DELETE" && path === `/documents/${DOC}`) {
        gone = true;
        return new Response(null, { status: 202 });
      }
    });
    fireEvent.click(await screen.findByRole("button", { name: m.actions.delete }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls("DELETE", `/documents/${DOC}`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: m.actions.deleteConfirm }));
    expect(await screen.findByText(m.list.emptyCase)).toBeTruthy();
    expect(calls("DELETE", `/documents/${DOC}`)).toHaveLength(1);
  });

  it("retries a failed document", async () => {
    let retried = false;
    const { calls } = await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents")
        return page([doc(DOC, retried ? { status: "queued" } : { status: "failed", error: "x" })]);
      if (method === "POST" && path === `/documents/${DOC}/retry`) {
        retried = true;
        return json(doc(DOC, { status: "queued" }), 202);
      }
    });
    fireEvent.click(await screen.findByRole("button", { name: m.actions.retry }));
    expect(await screen.findByText(m.status.queued)).toBeTruthy();
    expect(calls("POST", `/documents/${DOC}/retry`)).toHaveLength(1);
  });

  it("downloads the file through the API", async () => {
    const created = vi.fn(() => "blob:doc");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { calls } = await renderCase(({ method, path }) => {
      if (method === "GET" && path === "/documents") return page([doc(DOC)]);
      if (method === "GET" && path === `/documents/${DOC}/file`)
        // A string body: jsdom's Blob can't be handed to Node's Response.
        return new Response("%PDF-1.7", {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
    });
    fireEvent.click(await screen.findByRole("button", { name: m.actions.download }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls("GET", `/documents/${DOC}/file`)).toHaveLength(1);
    expect(created).toHaveBeenCalled();
    click.mockRestore();
  });
});

describe("Documents page", () => {
  it("lists every document with a link to its case", async () => {
    const { calls } = await renderWith(
      async () => {
        const { DocumentsList } = await import("@/components/documents/documents-list");
        return <DocumentsList showCase />;
      },
      ({ method, path }) => {
        if (method === "GET" && path === "/documents") return page([doc(DOC)]);
        if (method === "GET" && path === `/cases/${CASE}`)
          return json({ id: CASE, title: "State v. Ahmed", archivedAt: null });
      },
    );
    const link = await screen.findByRole("link", { name: "State v. Ahmed" });
    expect(link.getAttribute("href")).toBe(`/cases/${CASE}`);
    expect(calls("GET", "/documents")[0].query.get("caseId")).toBeNull();
  });
});
