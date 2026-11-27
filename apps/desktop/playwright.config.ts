import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Gate 6: the six core UI flows, against the built UI served by dev/bridge.mjs with the
// fake daemon. Run with `pnpm e2e` (builds first). Traces are off (`--trace off`).
const PORT = Number(process.env.E2E_PORT ?? 4799);
const chromium = process.env.PW_CHROMIUM_PATH ?? (existsSync("/opt/pw-browsers/chromium") && !process.env.CI ? "/opt/pw-browsers/chromium" : undefined);

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
    screenshot: "only-on-failure",
    ...(chromium ? { launchOptions: { executablePath: chromium } } : {}),
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: `node dev/bridge.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/__health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { FAKE_DAEMON_STEP_MS: "10" },
  },
});
