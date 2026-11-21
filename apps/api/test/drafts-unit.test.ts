import { describe, expect, it } from "vitest";
import type { Citation, DraftTemplate } from "../src/clients/ai.js";
import type { Case } from "../src/db/schema.js";
import { noteText, renderDocx, renderPdf } from "../src/drafts/export.js";
import { caseValue, fillFields, orderSections, partyLine } from "../src/drafts/fill.js";
import { markerIds, sectionMarkerIds, splitMarkers } from "../src/drafts/markers.js";
import { exportFilename } from "../src/routes/drafts.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const aCase = {
  title: "State v. Ahmed",
  court: "Sindh High Court",
  caseNumber: null,
  filedOn: "2026-10-01",
  parties: [
    { side: "claimant", name: "Ahmed Khan", label: "Petitioner" },
    { side: "respondent", name: "The State" },
  ],
  relevantLaws: ["s.497 CrPC", "s.324 PPC"],
} as unknown as Case;

const template = {
  fields: [
    { key: "court", caseField: "court" },
    { key: "parties", caseField: "parties" },
    { key: "fir", caseField: null },
    { key: "number", caseField: "caseNumber" },
  ],
  sections: [{ key: "facts" }, { key: "grounds" }],
} as unknown as DraftTemplate;

const citation = {
  id: A,
  sourceId: B,
  claim: "c",
  locator: "s. 497",
  verification: { status: "needs_review", flags: [], lastVerifiedAt: "2026-11-01T10:00:00Z" },
} as Citation;

describe("fill from case (FR-DRAFT-2)", () => {
  it("names parties with their label, or their side", () => {
    expect(aCase.parties.map(partyLine)).toEqual([
      "Ahmed Khan (Petitioner)",
      "The State (Respondent)",
    ]);
  });

  it("puts list fields one per line, and empty values as null", () => {
    expect(caseValue(aCase, "relevantLaws")).toBe("s.497 CrPC\ns.324 PPC");
    expect(caseValue(aCase, "filedOn")).toBe("2026-10-01");
    expect(caseValue(aCase, "caseNumber")).toBeNull();
  });

  it("fills only fields with a caseField, and nothing without a case", () => {
    expect(fillFields(template, aCase)).toEqual({
      court: "Sindh High Court",
      parties: "Ahmed Khan (Petitioner)\nThe State (Respondent)",
      fir: null,
      number: null,
    });
    expect(fillFields(template, undefined)).toEqual({
      court: null,
      parties: null,
      fir: null,
      number: null,
    });
  });

  it("orders sections by the template and fills missing ones with an empty body", () => {
    expect(orderSections(template, [{ key: "grounds", body: "g" }])).toEqual([
      { key: "facts", body: "" },
      { key: "grounds", body: "g" },
    ]);
  });
});

describe("markers", () => {
  it("finds each citation once, in order, case-insensitively", () => {
    const text = `x [[c:${B}]] y [[c:${A.toUpperCase()}]] z [[c:${B}]] [[c:not-a-uuid]]`;
    expect(markerIds(text)).toEqual([B, A]);
    expect(sectionMarkerIds([{ body: `[[c:${A}]]` }, { body: text }])).toEqual([A, B]);
  });

  it("splits text into runs and markers", () => {
    expect(splitMarkers(`a [[c:${A}]].`)).toEqual([
      { text: "a " },
      { citationId: A },
      { text: "." },
    ]);
  });
});

describe("export", () => {
  it("writes source, locator, the stored status and the last-verified date", () => {
    expect(noteText({ citation, sourceTitle: "Code of Criminal Procedure, 1898" })).toBe(
      "Code of Criminal Procedure, 1898, s. 497. Status: Needs review, last verified 2026-11-01.",
    );
  });

  it("renders a DOCX and a PDF", async () => {
    const model = {
      title: "Bail",
      sections: [
        { heading: "Grounds for bail", body: `1. Bail [[c:${A}]].\n2. Second [[c:${B}]].` },
      ],
      notes: new Map([[A, { citation, sourceTitle: "CrPC" }]]),
    };
    const docx = await renderDocx(model);
    expect(docx.subarray(0, 2).toString("latin1")).toBe("PK");
    const pdf = await renderPdf(model);
    expect(pdf.subarray(0, 4).toString("latin1")).toBe("%PDF");
  });

  it("names the file from the title", () => {
    expect(exportFilename("Bail: Ahmed / 2026", "pdf")).toBe("Bail-Ahmed-2026.pdf");
    expect(exportFilename("???", "docx")).toBe("draft.docx");
  });
});
