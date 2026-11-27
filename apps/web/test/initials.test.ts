import { describe, expect, it } from "vitest";
import { initials } from "../src/components/shell/initials";

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Ayesha Khan")).toBe("AK");
    expect(initials("  ayesha   khan  extra ")).toBe("AK");
    expect(initials("Ayesha")).toBe("A");
  });

  it("skips punctuation and words with no letter or digit (#250)", () => {
    expect(initials("Admin (screenshots)")).toBe("AS");
    expect(initials("Dr. - Khan")).toBe("DK");
    expect(initials("'Ali' Raza")).toBe("AR");
  });

  it("works for Urdu names", () => {
    expect(initials("عائشہ خان")).toBe("عخ");
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(initials("")).toBe("");
    expect(initials(" (-) ")).toBe("");
  });
});
