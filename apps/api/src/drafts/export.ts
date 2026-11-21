// Export a saved draft as DOCX or PDF (FR-DRAFT-4). Each [[c:<id>]] marker becomes a numbered
// note giving the source, locator, the stored status and its last-verified date at the time of
// export (FR-TRUST-5, FR-TRUST-10). The statuses come in from the trust store; nothing here
// decides one.
import { Document, FootnoteReferenceRun, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import type { Citation } from "../clients/ai.js";
import { splitMarkers } from "./markers.js";

export interface ExportNote {
  citation: Citation;
  /** The source's title, or a fallback when services/ai has no record of it. */
  sourceTitle: string;
}

export interface ExportModel {
  title: string;
  /** In template order, with the template's headings. */
  sections: { heading: string; body: string }[];
  /** By citation id. A marker without a note (it can't be read back) is dropped. */
  notes: Map<string, ExportNote>;
}

const STATUS_LABELS = {
  verified: "Verified",
  needs_review: "Needs review",
  unverified: "Unverified",
} as const;

/** One note's text: source, locator, status, last verified (date only). */
export function noteText(note: ExportNote): string {
  const { citation } = note;
  const where = citation.locator ? `${note.sourceTitle}, ${citation.locator}` : note.sourceTitle;
  const status = STATUS_LABELS[citation.verification.status];
  const verified = citation.verification.lastVerifiedAt.slice(0, 10);
  return `${where}. Status: ${status}, last verified ${verified}.`;
}

/** Numbers the notes in order of first appearance across the sections. */
function numbering(model: ExportModel): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const section of model.sections) {
    for (const part of splitMarkers(section.body)) {
      if (
        "citationId" in part &&
        model.notes.has(part.citationId) &&
        !numbers.has(part.citationId)
      ) {
        numbers.set(part.citationId, numbers.size + 1);
      }
    }
  }
  return numbers;
}

/** The paragraphs of a body: one per line, each split into text runs and note numbers. */
function lines(body: string): ({ text: string } | { citationId: string })[][] {
  return body.split(/\r?\n/).map((line) => splitMarkers(line));
}

export async function renderDocx(model: ExportModel): Promise<Buffer> {
  const numbers = numbering(model);
  const footnotes: Record<number, { children: Paragraph[] }> = {};
  for (const [id, n] of numbers) {
    footnotes[n] = { children: [new Paragraph(noteText(model.notes.get(id)!))] };
  }
  const children: Paragraph[] = [new Paragraph({ text: model.title, heading: HeadingLevel.TITLE })];
  for (const section of model.sections) {
    children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    for (const line of lines(section.body)) {
      children.push(
        new Paragraph({
          children: line.flatMap((part) => {
            if ("text" in part) return [new TextRun(part.text)];
            const n = numbers.get(part.citationId);
            return n ? [new FootnoteReferenceRun(n)] : [];
          }),
        }),
      );
    }
  }
  const doc = new Document({
    title: model.title,
    creator: "CaseGuard",
    footnotes,
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

export function renderPdf(model: ExportModel): Promise<Buffer> {
  const numbers = numbering(model);
  const doc = new PDFDocument({ size: "A4", margin: 72, info: { Title: model.title } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.font("Times-Bold").fontSize(16).text(model.title, { align: "center" }).moveDown();
  for (const section of model.sections) {
    doc.font("Times-Bold").fontSize(13).text(section.heading).moveDown(0.3);
    doc.font("Times-Roman").fontSize(12);
    for (const line of lines(section.body)) {
      const text = line
        .map((part) => {
          if ("text" in part) return part.text;
          const n = numbers.get(part.citationId);
          return n ? ` [${n}]` : "";
        })
        .join("");
      doc.text(text.length ? text : " ");
    }
    doc.moveDown();
  }
  if (numbers.size > 0) {
    doc.font("Times-Bold").fontSize(13).text("Citations").moveDown(0.3);
    doc.font("Times-Roman").fontSize(10);
    for (const [id, n] of numbers) doc.text(`[${n}] ${noteText(model.notes.get(id)!)}`);
  }
  doc.end();
  return done;
}
