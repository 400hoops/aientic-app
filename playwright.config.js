import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the real app: the real Express server, the real
 * build, a real browser. The only thing faked is the model itself (see
 * tests/stub-model.mjs) — everything else is what ships.
 *
 * `npm run test:e2e` builds the frontend, boots the server against a
 * throwaway data directory, and drives it. One browser: this app's whole
 * surface is a Chromium-class engine on a laptop and Safari on a phone, and
 * the phone-specific behaviour worth testing is layout, which the project
 * covers with a narrow viewport rather than a second engine.
 */
const PORT = Number(process.env.AIENTIC_E2E_PORT || 4187);

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // one server, one data directory, one history
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Most people will use the browser `npx playwright install chromium`
    // downloads. Set CHROMIUM_PATH to point at a system Chromium instead —
    // what container images that already ship one need, and what avoids a
    // second 150 MB download in CI.
    ...(process.env.CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.CHROMIUM_PATH } }
      : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // One sign-in per run, saved and reused: see tests/e2e/helpers.js.
    // Node-level, no browser, no server: the link reader's own rules.
    { name: "unit", testMatch: /readpage\.spec\.js/ },
    { name: "setup", testMatch: /auth\.setup\.js/ },
    {
      name: "desktop",
      dependencies: ["setup"],
      testIgnore: /readpage\.spec\.js/,
      use: { ...devices["Desktop Chrome"], storageState: "tests/.auth/admin.json" },
    },
  ],
  webServer: {
    // The build has to run first: the server serves dist/ in production mode,
    // and testing the dev server would test Vite rather than what ships.
    command: "npm run build && node tests/serve.mjs",
    url: `http://127.0.0.1:${PORT}/api/session`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
