import { defineConfig, devices } from "@playwright/test";

// Roubo runs the client dev server on port 3334 (see client/vite.config.ts).
// The fixture page at `client/source-picker-fixture.html` is Vite-served in
// dev mode only and is not part of the production build.
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 3334);
const BASE_URL = `http://localhost:${DEV_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev:client -- --port ${DEV_PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
