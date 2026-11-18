import type { Schemas } from "@/lib/api";

export type DocumentMediaType = Schemas["DocumentMediaType"];

// The upload limits of the documents contract (FR-DOC-1). The API sniffs the content and has the
// last word (413, 415); this check only saves the user a wasted upload.
export const MAX_BYTES = 26_214_400;

const byExtension: Record<string, DocumentMediaType> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const allowed = new Set<string>(Object.values(byExtension));

/** The `accept` attribute of the file picker. */
export const ACCEPT = [...allowed, ...Object.keys(byExtension).map((ext) => `.${ext}`)].join(",");

export type FileProblem = "type" | "size" | "empty";

/** Why a file can't be uploaded, or null. A missing browser type falls back to the extension. */
export function checkFile(file: Pick<File, "name" | "size" | "type">): FileProblem | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const type = file.type || byExtension[extension] || "";
  if (!allowed.has(type)) return "type";
  if (file.size === 0) return "empty";
  if (file.size > MAX_BYTES) return "size";
  return null;
}
