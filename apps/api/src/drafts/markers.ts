// Citation markers in draft text: `[[c:<citationId>]]` (api.v1 DraftSectionBody).

export const MARKER = /\[\[c:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/gi;

/** Every citation id marked in `text`, lower-cased, in order of first appearance. */
export function markerIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(MARKER)) seen.add(m[1]!.toLowerCase());
  return [...seen];
}

/** The citation ids marked anywhere in the sections, in order of first appearance. */
export function sectionMarkerIds(sections: { body: string }[]): string[] {
  return [...new Set(sections.flatMap((s) => markerIds(s.body)))];
}

/** Splits text into plain runs and markers, for export. */
export function splitMarkers(text: string): ({ text: string } | { citationId: string })[] {
  const parts: ({ text: string } | { citationId: string })[] = [];
  let cursor = 0;
  for (const m of text.matchAll(MARKER)) {
    if (m.index > cursor) parts.push({ text: text.slice(cursor, m.index) });
    parts.push({ citationId: m[1]!.toLowerCase() });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}
