import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// RTL smoke test (FR-I18N-1): layouts use logical properties only. Physical utilities such as
// `ml-2`, `pl-4`, `left-0`, `border-r` or `text-left` would stay put when Urdu flips the page.
const PHYSICAL =
  /^-?(m[lr]|p[lr]|left|right|scroll-m[lr]|scroll-p[lr])-|^(border-[lr]|rounded-[tb]?[lr])(-|$)|^(text|float|clear)-(left|right)$/;

const src = join(__dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

// Drops variant prefixes (`lg:`, `data-[side=left]:`, `rtl:`) and `!`, leaving the utility.
function utility(token: string): string {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

export function physicalClasses(source: string): string[] {
  return source
    .split(/[\s"'`{}()]+/)
    .filter(Boolean)
    .filter((token) => PHYSICAL.test(utility(token)));
}

describe("RTL-safe styling (FR-I18N-1)", () => {
  it("flags physical utilities and allows logical ones", () => {
    expect(physicalClasses('className="ml-2 lg:pl-64 -mr-1 left-0 text-right border-l"')).toEqual([
      "ml-2",
      "lg:pl-64",
      "-mr-1",
      "left-0",
      "text-right",
      "border-l",
    ]);
    expect(
      physicalClasses(
        'className="ms-2 lg:ps-64 start-0 text-start border-s data-[side=left]:slide-in-from-right-2"',
      ),
    ).toEqual([]);
  });

  it("no source file uses physical left/right utilities", () => {
    const offenders = files(src).flatMap((file) =>
      physicalClasses(readFileSync(file, "utf8")).map((c) => `${relative(src, file)}: ${c}`),
    );
    expect(offenders).toEqual([]);
  });
});
