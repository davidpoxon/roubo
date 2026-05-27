import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The stubbed plugin (WU-060) lives outside the bundled `plugins/` tree; the
// e2e-harness and e2e-flow specs need it discoverable so they can drive it
// per-scenario via /test/__reset. Pointing ROUBO_USER_PLUGINS_DIR at
// `e2e/fixtures/` lets the plugin-manager walk into `stubbed-plugin/` and
// register it as the `e2e-stub` plugin alongside the real bundled ones.
const E2E_USER_PLUGINS_DIR = path.resolve(__dirname, "e2e", "fixtures");
// WU-068: the project-settings specs need the github-com / ghe /
// jira-self-hosted plugin slots to surface scenario-pinned data instead of
// making real API calls. Pointing ROUBO_BUNDLED_PLUGINS_DIR at
// `e2e/fixtures/bundled-overlays/` swaps the bundled plugins for thin stubs
// whose entrypoints re-export the canonical e2e-stub runtime. The manifest
// ids stay `github-com` / `ghe` / `jira-self-hosted`, so hardcoded
// `plugin.id === ...` UI branches (PluginConfigureDialog: integration-fields
// section, OAuth section, instance handling) activate as they would in prod.
const E2E_BUNDLED_PLUGINS_DIR = path.resolve(__dirname, "e2e", "fixtures", "bundled-overlays");

// Four surfaces share one config:
//   - dev-fixture: drives the Vite-served `client/source-picker-fixture.html`
//     for component-shape coverage (TC-021/022/076). Dev-mode only.
//   - e2e-harness: drives the BUILT Roubo app (server serving the built client
//     via express.static) with ROUBO_E2E=1 enabling POST /test/__reset. Holds
//     the WU-064 harness-shape specs (smoke, determinism, gate behaviour).
//   - e2e-flow: same built-app surface, holds the WU-063 user-flow specs
//     (TC-156..TC-160). Each spec pins the stubbed plugin to a dedicated
//     scenario + frozen-now via /test/__reset.
//   - e2e-plugin-grid: same built-app surface, holds the WU-065 plugin-grid
//     responsive-layout spec (TC-170). Relies on the four sibling stubbed
//     plugin fixtures (e2e-stub-2..e2e-stub-5) being present alongside the
//     canonical e2e-stub under e2e/fixtures/ so the Settings > Plugins grid
//     renders the five cards the spec asserts column wrap against.
//   - connection-status: same built-app surface, holds the WU-064 specs
//     (TC-168 three-placement surfacing, TC-169 auth-problem flip).
//   - cut-list-ui: same built-app surface, holds the WU-067 specs
//     (TC-173..TC-176 cut-list filtering, facets, chip taxonomy). Each spec
//     pins the stubbed plugin to a dedicated scenario + frozen-now.
//   - e2e-alerts: same built-app surface, holds the WU-069 spec
//     (TC-180 Dependabot alerts toggle + re-consent + cut-list rendering).
//   - project-settings: same built-app surface, holds the WU-068 specs
//     (TC-177/178/179/182). These rely on the `bundled-overlays/` stub
//     plugins replacing the real github-com / ghe / jira-self-hosted under
//     ROUBO_BUNDLED_PLUGINS_DIR, plus `/test/__register-fixture-project` to
//     hand each spec a registered project pointing at the right overlay.
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 3334);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3336);
const DEV_BASE_URL = `http://localhost:${DEV_PORT}`;
const SERVER_BASE_URL = `http://localhost:${SERVER_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  // Single worker so that parallel spec files cannot race POST /test/__reset
  // against each other (the second concurrent reset would see plugin-manager
  // mid-initialize and throw "already initialized"). NFR-018 calls for
  // deterministic runs, and serial execution is the simplest contract.
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "dev-fixture",
      testMatch: ["source-picker.spec.ts", "enable-plugin-prompt.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: DEV_BASE_URL },
    },
    {
      name: "e2e-harness",
      testMatch: ["e2e-harness/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "e2e-flow",
      testMatch: ["e2e-flow/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "e2e-plugin-grid",
      testMatch: ["plugin-grid/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "connection-status",
      testMatch: ["connection-status/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "cut-list-ui",
      testMatch: ["cut-list-ui/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "e2e-alerts",
      testMatch: ["alerts/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "project-settings",
      testMatch: ["project-settings/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "plugin-lifecycle",
      testMatch: ["plugin-lifecycle/**/*.spec.ts"],
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
        ROUBO_USER_PLUGINS_DIR: E2E_USER_PLUGINS_DIR,
        ROUBO_BUNDLED_PLUGINS_DIR: E2E_BUNDLED_PLUGINS_DIR,
      },
      url: SERVER_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
