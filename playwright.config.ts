import { defineConfig, devices } from "@playwright/test";

// Two surfaces share one config:
//   - dev-fixture: drives the Vite-served `client/source-picker-fixture.html`
//     for component-shape coverage (TC-021/022/076). Dev-mode only.
//   - e2e-harness: drives the BUILT Roubo app (server serving the built client
//     via express.static) with ROUBO_E2E=1 enabling POST /test/__reset. This is
//     the surface WU-064 onwards will populate with TC-175/176/177/181 specs.
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 3334);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3336);
const DEV_BASE_URL = `http://localhost:${DEV_PORT}`;
const SERVER_BASE_URL = `http://localhost:${SERVER_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "dev-fixture",
      testMatch: ["source-picker.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: DEV_BASE_URL },
    },
    {
      name: "e2e-harness",
      testMatch: ["e2e-harness/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
  ],
  webServer: [
    {
      command: "npm run dev:client",
      env: { DEV_PORT: String(DEV_PORT) },
      url: DEV_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "npm run start -w server",
      env: {
        ROUBO_PORT: String(SERVER_PORT),
        ROUBO_E2E: "1",
      },
      url: SERVER_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
