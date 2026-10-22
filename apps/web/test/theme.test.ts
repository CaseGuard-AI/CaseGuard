import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, THEME_KEY, themeScript } from "@/lib/theme";

// A controllable `prefers-color-scheme: dark` query. jsdom has no matchMedia.
function mockSystem(dark: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) =>
      listeners.delete(fn),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  return {
    listeners,
    change(next: boolean) {
      query.matches = next;
      for (const fn of listeners) fn({ matches: next } as MediaQueryListEvent);
    },
  };
}

const painted = () => document.documentElement.dataset.theme;

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  applyTheme("light"); // detaches any system listener
  vi.unstubAllGlobals();
});

describe("applyTheme", () => {
  it("paints light or dark and caches the choice", () => {
    mockSystem(false);
    applyTheme("dark");
    expect(painted()).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    applyTheme("light");
    expect(painted()).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
  });

  it("follows the device for system, including later changes", () => {
    const system = mockSystem(true);
    applyTheme("system");
    expect(painted()).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
    system.change(false);
    expect(painted()).toBe("light");
  });

  it("stops following the device once a fixed theme is chosen", () => {
    const system = mockSystem(false);
    applyTheme("system");
    applyTheme("light");
    expect(system.listeners.size).toBe(0);
    system.change(true);
    expect(painted()).toBe("light");
  });
});

describe("the head script", () => {
  const run = () => new Function(themeScript)();

  it("applies the cached theme before React loads", () => {
    mockSystem(true);
    localStorage.setItem(THEME_KEY, "light");
    run();
    expect(painted()).toBe("light");
    localStorage.setItem(THEME_KEY, "dark");
    run();
    expect(painted()).toBe("dark");
  });

  it("follows the device when nothing is cached or the choice is system", () => {
    mockSystem(true);
    run();
    expect(painted()).toBe("dark");
    localStorage.setItem(THEME_KEY, "system");
    mockSystem(false);
    run();
    expect(painted()).toBe("light");
  });
});
