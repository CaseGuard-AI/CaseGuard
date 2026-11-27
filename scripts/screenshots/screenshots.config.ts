// Playwright config for the screenshot proof folder (#239). Run with `pnpm screenshots`.
//
// It drives the app that `pnpm dev` already serves: it never starts a server. The base URLs come
// from the environment, with the defaults of apps/web (`next dev --port 3000`) and apps/api
// (`API_PORT=4000`, `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`). See
// docs/screenshots/README.md for the prerequisites.
import { defineConfig, devices, type BrowserContextOptions } from "@playwright/test";

export const WEB_URL = (process.env.SCREENSHOTS_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const API_URL = (process.env.SCREENSHOTS_API_URL ?? "http://localhost:4000/api/v1").replace(
  /\/$/,
  "",
);

// `defaultBrowserType` is a runner option, not a context one.
const { defaultBrowserType: _browser, ...desktopChrome } = devices["Desktop Chrome"];

// Shared by the config and by capture.ts, which opens extra contexts (signed out, Urdu, admin).
export const CONTEXT: BrowserContextOptions = {
  ...desktopChrome,
  baseURL: WEB_URL,
  // Wide enough for the desktop layout: the sidebar and the research history column.
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "en-GB",
  timezoneId: "Asia/Karachi",
};

export default defineConfig({
  testDir: ".",
  testMatch: "capture.ts",
  // One browser, one signed-in page, captured in file order.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // Research and drafting assist wait for a model and the trust layer.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  outputDir: "../../node_modules/.cache/screenshots-results",
  use: {
    ...CONTEXT,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
