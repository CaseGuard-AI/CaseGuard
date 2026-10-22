import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import ur from "../messages/ur.json";
import { directionOf, routing } from "@/i18n/routing";

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

describe("messages (FR-I18N-1)", () => {
  it("en and ur define exactly the same keys", () => {
    expect(keys(ur).sort()).toEqual(keys(en).sort());
  });

  it("no message is empty", () => {
    for (const [name, messages] of Object.entries({ en, ur })) {
      const empty = keys(messages).filter((k) => {
        const value = k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], messages);
        return typeof value !== "string" || value.trim() === "";
      });
      expect(empty, name).toEqual([]);
    }
  });
});

describe("routing", () => {
  it("supports en (default) and ur", () => {
    expect(routing.locales).toEqual(["en", "ur"]);
    expect(routing.defaultLocale).toBe("en");
  });

  it("Urdu is right-to-left (FR-LANG-2)", () => {
    expect(directionOf("ur")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
  });
});
