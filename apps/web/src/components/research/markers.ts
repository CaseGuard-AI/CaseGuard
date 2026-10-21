export type Segment = { text: string } | { citationId: string; n: number };

export type ParsedAnswer = {
  paragraphs: Segment[][];
  /** Citation ids in display order: first appearance in the text, then any never marked. */
  order: string[];
};

const MARKER = /\[\[c:([^\]\s]+)\]\]/g;

// Splits an answer on its `[[c:<citationId>]]` markers (api.v1 `Message.text`). Each citation is
// numbered by where it first appears. A marker with no matching citation is dropped: there is no
// stored status to show for it (FR-TRUST-10).
export function parseAnswer(text: string, citationIds: readonly string[]): ParsedAnswer {
  const known = new Set(citationIds);
  const numbers = new Map<string, number>();
  const numberOf = (id: string) => {
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
    return numbers.get(id)!;
  };

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => {
      const segments: Segment[] = [];
      let last = 0;
      for (const match of paragraph.matchAll(MARKER)) {
        if (match.index > last) segments.push({ text: paragraph.slice(last, match.index) });
        const id = match[1];
        if (known.has(id)) segments.push({ citationId: id, n: numberOf(id) });
        last = match.index + match[0].length;
      }
      if (last < paragraph.length) segments.push({ text: paragraph.slice(last) });
      return segments;
    });

  for (const id of citationIds) numberOf(id);
  return { paragraphs, order: [...numbers.keys()] };
}
