import { describe, expect, it } from "vitest";
import { parseAnswer } from "@/components/research/markers";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

describe("parseAnswer", () => {
  it("numbers citations by first appearance and reuses the number", () => {
    const { paragraphs, order } = parseAnswer(`One [[c:${B}]] two [[c:${A}]] three [[c:${B}]].`, [
      A,
      B,
    ]);
    expect(paragraphs).toEqual([
      [
        { text: "One " },
        { citationId: B, n: 1 },
        { text: " two " },
        { citationId: A, n: 2 },
        { text: " three " },
        { citationId: B, n: 1 },
        { text: "." },
      ],
    ]);
    expect(order).toEqual([B, A]);
  });

  it("drops a marker with no matching citation", () => {
    const { paragraphs, order } = parseAnswer(`Claim [[c:${C}]] and [[c:${A}]]`, [A]);
    expect(paragraphs).toEqual([[{ text: "Claim " }, { text: " and " }, { citationId: A, n: 1 }]]);
    expect(order).toEqual([A]);
  });

  it("splits paragraphs on blank lines and numbers across them", () => {
    const { paragraphs } = parseAnswer(`First [[c:${A}]].\n\n  \nSecond [[c:${B}]].`, [A, B]);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]).toContainEqual({ citationId: B, n: 2 });
  });

  it("keeps text without markers and lists citations never marked last", () => {
    const { paragraphs, order } = parseAnswer("No markers here.", [A, B]);
    expect(paragraphs).toEqual([[{ text: "No markers here." }]]);
    expect(order).toEqual([A, B]);
  });
});
