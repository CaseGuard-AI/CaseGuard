// The screenshot proof folder (#239): one PNG per built feature, written to docs/screenshots/.
//
// Assumes `pnpm dev` is running (web, api and ai). Each run registers a throwaway Lawyer, seeds a
// case with research, a draft and a lint report through the public API, signs in through the UI
// and visits each screen. Screens that need the corpus or a model (07, 09, 10, 12) are skipped with
// a logged reason when that service answers 503 or an error, so no image shows a failure. A skipped
// screen's old image is removed first, so the folder never holds a stale one.
//
// Run: pnpm screenshots          (see docs/screenshots/README.md for the prerequisites)
import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import type { components } from "../../packages/contracts/generated/api.v1.ts";
import { API_URL, CONTEXT } from "./screenshots.config.ts";

type Schemas = components["schemas"];

// The repo has no "type": "module", so Playwright loads this file as CommonJS.
const ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(ROOT, "docs/screenshots");
const PASSWORD = "Screenshots-2026!";
const RUN = Date.now().toString(36);

const RESEARCH_QUESTION =
  process.env.SCREENSHOTS_RESEARCH_QUESTION ?? "What is the punishment under s. 302 PPC?";
const PRECEDENT_QUERY = process.env.SCREENSHOTS_PRECEDENT_QUERY ?? "bail under s. 497 CrPC";

// UI strings come from the app's own messages, so a copy change doesn't break the selectors.
const en = JSON.parse(readFileSync(resolve(ROOT, "apps/web/messages/en.json"), "utf8")) as Messages;
type Messages = { [key: string]: string | Messages };
function msg(path: string): string {
  const value = path.split(".").reduce<string | Messages | undefined>(
    (node, key) => (node && typeof node === "object" ? node[key] : undefined),
    en,
  );
  if (typeof value !== "string") throw new Error(`No message ${path} in apps/web/messages/en.json`);
  return value;
}
const msgOr = (path: string, fallback: string) => {
  try {
    return msg(path);
  } catch {
    return fallback;
  }
};

// ── API ─────────────────────────────────────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`${path} → ${status}: ${body.slice(0, 300)}`);
  }
}

async function call<T>(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, `${method} ${path}`, text);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A failure worth a skip, not a crash: the service is down, rate-limited, or answered oddly. */
function reasonOf(err: unknown): string {
  if (err instanceof ApiError) return `the API answered ${err.status} (${err.message})`;
  return err instanceof Error ? err.message : String(err);
}

// ── Seed ────────────────────────────────────────────────────────────────────────────────────────

type Seed = {
  email: string;
  token: string;
  caseId: string;
  caseTitle: string;
  conversationId: string;
  conversationTitle: string;
  /** Why the research answer can't be shown, or null when it has cited sources. */
  answerSkip: string | null;
  /** Why no processed document can be shown, or null when one is done or flagged. */
  documentSkip: string | null;
  draftId: string;
  draftTitle: string;
  lintReportId: string;
  lintTitle: string;
};

const BAIL_TEXT = `IN THE COURT OF THE SESSIONS JUDGE, KARACHI SOUTH

Bail Application No. ____ of 2026

Muhammad Aslam son of Abdul Rashid ........ Applicant / Accused

VERSUS

The State ........ Respondent

APPLICATION UNDER SECTION 497 CR.P.C. FOR THE GRANT OF POST-ARREST BAIL

Respectfully Sheweth:

1. That the applicant was arrested in FIR No. 214 of 2026 registered at Police Station Saddar.
2. That the applicant is innocent and has been falsely implicated in this case.
3. That the case calls for further inquiry within the meaning of section 497(2) Cr.P.C.

PRAYER

It is therefore prayed that the applicant may kindly be released on bail.

Advocate for the Applicant`;

/** A one-page PDF with real text, so document processing has something to extract (FR-DOC-1). */
function samplePdf(): Buffer {
  const lines = [
    "FIR No. 214 of 2026, Police Station Saddar, Karachi South",
    "Offence: section 302 PPC. Accused: Muhammad Aslam son of Abdul Rashid.",
    "Recovered: nothing from the possession of the accused.",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l}) '`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** Uploads the sample PDF to the case and waits for processing: null once it is done or flagged. */
async function uploadDocument(token: string, caseId: string): Promise<string | null> {
  const form = new FormData();
  const pdf = new Blob([new Uint8Array(samplePdf())], { type: "application/pdf" });
  form.append("file", pdf, "fir-214-2026.pdf");
  try {
    const res = await fetch(`${API_URL}/cases/${caseId}/documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) return `the upload answered ${res.status}: ${(await res.text()).slice(0, 300)}`;
    const doc = (await res.json()) as Schemas["Document"];
    for (let i = 0; i < 60; i++) {
      const now = await call<Schemas["Document"]>("GET", `/documents/${doc.id}`, token);
      if (now.status === "done" || now.status === "flagged") return null;
      if (now.status === "failed") {
        await call("DELETE", `/documents/${doc.id}`, token);
        return "the document failed to process (is the ai service running?)";
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    await call("DELETE", `/documents/${doc.id}`, token);
    return "the document was still processing after two minutes";
  } catch (err) {
    return reasonOf(err);
  }
}

async function registerUser(name: string, email: string): Promise<Schemas["Session"]> {
  const body: Schemas["RegisterRequest"] = { email, password: PASSWORD, name, locale: "en", role: "lawyer" };
  return call<Schemas["Session"]>("POST", "/auth/register", null, body);
}

async function seed(): Promise<Seed> {
  const email = `screenshots+${RUN}@example.com`;
  const { accessToken: token } = await registerUser("Ayesha Siddiqui", email);

  const caseTitle = `State v. Muhammad Aslam (${RUN})`;
  const caseInput: Schemas["CaseInput"] = {
    title: caseTitle,
    court: "Sessions Court, Karachi South",
    caseNumber: "Cr. Bail No. 214 of 2026",
    caseType: "Cr. Bail",
    filedOn: "2026-10-02",
    status: "Arguments on bail",
    nextHearingOn: "2026-12-10",
    parties: [
      { side: "claimant", name: "Muhammad Aslam", label: "Applicant" },
      { side: "respondent", name: "The State", label: "Respondent" },
    ],
    judge: "Mr. Justice (R) Example",
    assignedLawyer: "Ayesha Siddiqui",
    relevantLaws: ["s.497 CrPC", "s.302 PPC"],
    summary:
      "Post-arrest bail for an accused in FIR No. 214 of 2026, P.S. Saddar. The defence argues the case calls for further inquiry.",
  };
  const created = await call<Schemas["Case"]>("POST", "/cases", token, caseInput);

  // Research saved to the case (FR-CASE-5). The answer needs the corpus and a model; when either
  // is down the conversation still exists, so the history screen has something to show.
  const conversationTitle = `Punishment under s. 302 PPC (${RUN})`;
  const conversation = await call<Schemas["Conversation"]>("POST", "/conversations", token, {
    title: conversationTitle,
    caseId: created.id,
  });
  let answerSkip: string | null = null;
  try {
    const ask: Schemas["AskRequest"] = { question: RESEARCH_QUESTION };
    const answer = await call<Schemas["Message"]>(
      "POST",
      `/conversations/${conversation.id}/messages`,
      token,
      ask,
    );
    if (answer.answerable === false) answerSkip = "the question was marked unanswerable";
    else if (!answer.citations?.length) answerSkip = "the answer came back without citations";
  } catch (err) {
    answerSkip = reasonOf(err);
  }

  // A document on the case, for the documents list (FR-DOC-1, FR-DOC-3).
  const documentSkip = await uploadDocument(token, created.id);

  // A draft from a template, filled from the case (FR-DRAFT-1, FR-DRAFT-2).
  const draftTitle = `Bail application: Muhammad Aslam (${RUN})`;
  const draftBody: Schemas["DraftCreate"] = {
    templateId: "bail_application",
    title: draftTitle,
    caseId: created.id,
  };
  const draft = await call<Schemas["Draft"]>("POST", "/drafts", token, draftBody);

  // A lint report saved to the case (FR-LINT-1, FR-CASE-5). No model is called.
  const lintTitle = `Bail application check (${RUN})`;
  const lintBody: Schemas["LintReportCreate"] = {
    documentType: "bail_application",
    text: BAIL_TEXT,
    title: lintTitle,
    caseId: created.id,
    draftId: draft.id,
  };
  const report = await call<Schemas["LintReport"]>("POST", "/lint-reports", token, lintBody);

  return {
    email,
    token,
    caseId: created.id,
    caseTitle,
    conversationId: conversation.id,
    conversationTitle,
    answerSkip,
    documentSkip,
    draftId: draft.id,
    draftTitle,
    lintReportId: report.id,
    lintTitle,
  };
}

// ── Browser helpers ─────────────────────────────────────────────────────────────────────────────

const file = (name: string) => resolve(OUT_DIR, `${name}.png`);

/** Removes the old image, so a skipped screen leaves no stale one behind. */
function clear(name: string) {
  rmSync(file(name), { force: true });
}

function skip(name: string, reason: string): never {
  console.log(`[screenshots] skip ${name}: ${reason}`);
  test.info().annotations.push({ type: "skip-reason", description: reason });
  test.skip(true, reason);
  throw new Error("unreachable");
}

/** Waits until nothing in <main> is loading, then fails if an error is showing. */
async function settle(page: Page) {
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

async function visibleAlert(page: Page, scope: Locator = page.locator("main")): Promise<string | null> {
  const alerts = scope.locator('[role="alert"]');
  for (const alert of await alerts.all()) {
    if (await alert.isVisible()) return (await alert.innerText()).trim() || "an error is showing";
  }
  return null;
}

/** Captures the page once `ready` is visible and the screen has settled without an error. */
// `next dev` draws its dev-tools button and issue badges here; they're not part of the app.
const HIDE_DEV_OVERLAY = "nextjs-portal { display: none !important; }";

async function capture(
  page: Page,
  name: string,
  ready: Locator,
  target?: Locator,
  mask: Locator[] = [],
) {
  await expect(ready.first()).toBeVisible();
  await settle(page);
  const alert = await visibleAlert(page);
  if (alert) throw new Error(`${name} shows an error: ${alert}`);
  mkdirSync(OUT_DIR, { recursive: true });
  const options = {
    path: file(name),
    animations: "disabled" as const,
    caret: "hide" as const,
    style: HIDE_DEV_OVERLAY,
    mask,
    maskColor: "#e5e7eb", // a neutral grey, not the default magenta
  };
  if (target) {
    await target.screenshot(options);
  } else {
    // The viewport, not the full page: the app shell's sidebar and header are fixed, so a
    // full-page capture repeats them halfway down. Centre the screen's key element when it
    // starts below the fold; a tall one that starts in view (a form) stays at the top.
    await ready.first().evaluate((el) => {
      const box = el.getBoundingClientRect();
      if (box.top < 0 || box.top > window.innerHeight - 120) el.scrollIntoView({ block: "center" });
    });
    await settle(page);
    await page.screenshot(options);
  }
  console.log(`[screenshots] wrote docs/screenshots/${name}.png`);
}

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/en/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"));
  await expect(page.locator("main h1").first()).toBeVisible();
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext(CONTEXT);
  return context.newPage();
}

const heading = (page: Page, text: string) =>
  page.locator("main").getByRole("heading", { name: text, exact: true });

// ── Screens ─────────────────────────────────────────────────────────────────────────────────────

let data: Seed;
let page: Page;

test.beforeAll(async ({ browser }) => {
  try {
    await call("GET", "/health", null);
  } catch (err) {
    throw new Error(`The API at ${API_URL} isn't answering (${reasonOf(err)}). Start it with \`pnpm dev\`.`);
  }
  data = await seed();
  console.log(`[screenshots] seeded ${data.email}, case ${data.caseId}`);
  page = await newPage(browser);
  await signIn(page, data.email);
});

test.afterAll(async () => {
  await page?.context().close();
});

test("01-login", async ({ browser }) => {
  clear("01-login");
  const anon = await newPage(browser);
  await anon.goto("/en/login");
  await capture(anon, "01-login", anon.locator('input[name="password"]'));
  await anon.context().close();
});

test("02-register", async ({ browser }) => {
  clear("02-register");
  const anon = await newPage(browser);
  await anon.goto("/en/register");
  await capture(anon, "02-register", anon.locator('input[name="name"]'));
  await anon.context().close();
});

test("03-dashboard-recent-research-cases-drafts", async () => {
  const name = "03-dashboard-recent-research-cases-drafts";
  clear(name);
  await page.goto("/en");
  await expect(page.locator("main").getByText(data.conversationTitle).first()).toBeVisible();
  await capture(page, name, page.locator("main").getByText(data.caseTitle));
});

test("04-cases-list", async () => {
  clear("04-cases-list");
  await page.goto("/en/cases");
  await capture(page, "04-cases-list", page.locator("main").getByText(data.caseTitle));
});

test("05-case-new", async () => {
  clear("05-case-new");
  await page.goto("/en/cases/new");
  await capture(page, "05-case-new", page.locator("main form"));
});

test("06-case-dashboard", async () => {
  clear("06-case-dashboard");
  await page.goto(`/en/cases/${data.caseId}`);
  await expect(page.locator("main").getByText(data.lintTitle).first()).toBeVisible();
  await capture(page, "06-case-dashboard", heading(page, data.caseTitle));
});

test("07-research-answer-with-citations", async () => {
  const name = "07-research-answer-with-citations";
  clear(name);
  if (data.answerSkip) skip(name, data.answerSkip);
  await page.goto(`/en/research?c=${data.conversationId}`);
  await capture(page, name, page.locator("main article"));
});

test("08-research-history", async () => {
  clear("08-research-history");
  await page.goto("/en/research");
  const history = page.locator("main nav", { hasText: msg("Research.history.title") });
  await capture(page, "08-research-history", history.getByText(data.conversationTitle));
});

// Precedent search reads the corpus and the graph; no model. 09 and 10 share one search.
let precedentSkip: string | null = null;
let relatedHit: string | null = null;

test("09-precedent-search-results", async () => {
  const name = "09-precedent-search-results";
  clear(name);
  clear("10-precedent-relationships");
  try {
    const search: Schemas["PrecedentSearch"] = { query: PRECEDENT_QUERY, includeGraphDerived: true, limit: 10 };
    const result = await call<Schemas["PrecedentSearchResult"]>("POST", "/precedents/search", data.token, search);
    if (result.hits.length === 0) precedentSkip = `no judgments match "${PRECEDENT_QUERY}"`;
    for (const hit of result.hits) {
      const rels = await call<Schemas["RelationshipList"]>(
        "GET",
        `/precedents/${hit.sourceId}/relationships`,
        data.token,
      );
      if (rels.items.length > 0) {
        relatedHit = hit.sourceId;
        break;
      }
    }
  } catch (err) {
    precedentSkip = reasonOf(err);
  }
  if (precedentSkip) skip(name, precedentSkip);

  await page.goto("/en/precedents");
  const form = page.locator('main form[role="search"]');
  await form.locator('input[type="search"]').fill(PRECEDENT_QUERY);
  await form.locator('button[type="submit"]').click();
  const hits = page.locator("main [data-hit]");
  await expect(hits.first().or(form.locator('[role="alert"]'))).toBeVisible({ timeout: 60_000 });
  const alert = await visibleAlert(page, form);
  if (alert) {
    precedentSkip = `the search showed an error: ${alert}`;
    skip(name, precedentSkip);
  }
  await capture(page, name, hits);
});

test("10-precedent-relationships", async () => {
  const name = "10-precedent-relationships";
  if (precedentSkip) skip(name, precedentSkip);
  if (!relatedHit) skip(name, "none of the hits has a relationship in the graph (run `pnpm ai:graph-build`)");
  const card = page.locator(`main [data-hit="${relatedHit}"]`);
  // The card's title is a button today; #238 makes the whole card one.
  const button = card.locator("button").first();
  await ((await button.count()) > 0 ? button : card).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("[data-relationship]").first().or(dialog.locator('[role="alert"]'))).toBeVisible();
  const alert = await visibleAlert(page, dialog);
  if (alert) skip(name, `the relationships panel showed an error: ${alert}`);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: file(name), animations: "disabled", caret: "hide", style: HIDE_DEV_OVERLAY });
  console.log(`[screenshots] wrote docs/screenshots/${name}.png`);
  await page.keyboard.press("Escape");
});

test("11-drafting-templates", async () => {
  clear("11-drafting-templates");
  await page.goto("/en/drafting");
  await capture(page, "11-drafting-templates", page.locator("main").getByText(data.draftTitle));
});

test("12-draft-editor-ai-assist", async () => {
  const name = "12-draft-editor-ai-assist";
  clear(name);
  await page.goto(`/en/drafting/${data.draftId}`);
  await expect(page.locator("main textarea").first()).toBeVisible();
  await settle(page);
  await page.locator("main").getByRole("button", { name: msg("Drafting.assist.open"), exact: true }).first().click();
  const panel = page.locator('main [role="region"]').first();
  await panel.getByRole("button", { name: msg("Drafting.assist.run"), exact: true }).click();
  const insert = panel.getByRole("button", { name: msg("Drafting.assist.insert"), exact: true });
  const done = insert
    .or(panel.locator('[role="alert"]'))
    .or(panel.getByText(msg("Drafting.assist.empty")));
  await expect(done.first()).toBeVisible({ timeout: 150_000 });
  const alert = await visibleAlert(page, panel);
  if (alert) skip(name, `drafting assist showed an error: ${alert}`);
  if (!(await insert.isVisible())) skip(name, "drafting assist returned no text");
  await capture(page, name, insert);
});

test("13-linter-findings", async () => {
  clear("13-linter-findings");
  await page.goto(`/en/linter?report=${data.lintReportId}`);
  await capture(page, "13-linter-findings", heading(page, msg("Linter.result.title")));
});

test("14-lint-report-saved-to-case", async () => {
  const name = "14-lint-report-saved-to-case";
  clear(name);
  await page.goto(`/en/cases/${data.caseId}`);
  const title = page.locator("main").getByText(data.lintTitle, { exact: true });
  // `has` is matched inside each section, so it must not start from `main` again.
  const section = page
    .locator("main section", { has: page.getByText(data.lintTitle, { exact: true }) })
    .last();
  await section.scrollIntoViewIfNeeded();
  await capture(page, name, title, section);
});

test("15-documents-list", async () => {
  clear("15-documents-list");
  if (data.documentSkip) skip("15-documents-list", data.documentSkip);
  await page.goto("/en/documents");
  await capture(page, "15-documents-list", page.locator("main [data-document]"));
});

test("16-settings-models-keys", async () => {
  clear("16-settings-models-keys");
  await page.goto("/en/settings");
  await capture(page, "16-settings-models-keys", heading(page, msg("Settings.models.title")));
});

test("19-sidebar-soon-badges", async () => {
  const name = "19-sidebar-soon-badges";
  clear(name);
  await page.goto("/en");
  const nav = page.getByRole("navigation", { name: msg("Nav.main"), exact: true });
  await expect(nav).toBeVisible();
  const soon = msgOr("Nav.soon", "Soon");
  const badge = nav.getByText(soon, { exact: true });
  if ((await badge.count()) === 0) skip(name, `no "${soon}" badge in the sidebar yet (it comes with #238)`);
  // The whole navy sidebar: the navigation's parent.
  await capture(page, name, badge, nav.locator(".."));
});

test("18-urdu-rtl-dark", async ({ browser }) => {
  const name = "18-urdu-rtl-dark";
  clear(name);
  const prefs: Schemas["UserSettingsUpdate"] = { locale: "ur", theme: "dark" };
  await call("PATCH", "/me/settings", data.token, prefs);
  const ur = await newPage(browser);
  try {
    // A fresh sign-in applies the saved language and theme.
    await signIn(ur, data.email);
    await expect(ur.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(ur.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(ur).toHaveURL(/\/ur(\/|$|\?)/);
    await capture(ur, name, ur.locator("main").getByText(data.caseTitle));
  } finally {
    await ur.context().close();
    const back: Schemas["UserSettingsUpdate"] = { locale: "en", theme: "light" };
    await call("PATCH", "/me/settings", data.token, back);
  }
});

test("17-admin-console", async ({ browser }) => {
  const name = "17-admin-console";
  clear(name);
  let email = process.env.SCREENSHOTS_ADMIN_EMAIL;
  const password = process.env.SCREENSHOTS_ADMIN_PASSWORD;
  if (email && !password) skip(name, "SCREENSHOTS_ADMIN_EMAIL is set without SCREENSHOTS_ADMIN_PASSWORD");
  if (!email) {
    // Register a second throwaway user and promote it with the repo's own script, which promotes
    // an existing user without asking for a password (apps/api/src/db/create-admin.ts).
    email = `screenshots-admin+${RUN}@example.com`;
    await registerUser("Admin (screenshots)", email);
    const promote = spawnSync("pnpm", ["db:create-admin", "--email", email], {
      cwd: ROOT,
      shell: process.platform === "win32",
      encoding: "utf8",
    });
    if (promote.status !== 0) {
      skip(name, `pnpm db:create-admin failed: ${(promote.stderr || promote.stdout).trim().slice(-300)}`);
    }
  }
  const admin = await newPage(browser);
  try {
    await signIn(admin, email, password);
    await admin.goto("/en/admin");
    // The repo is public: mask every user but this run's throwaway @example.com ones.
    const realUsers = admin.locator("main li").filter({ hasNotText: "@example.com" });
    await capture(admin, name, admin.locator('main [role="tablist"]'), undefined, [realUsers]);
  } finally {
    await admin.context().close();
  }
});

