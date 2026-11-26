import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { AGENT_ARGV_LOG_PATH } from "./e2e/agent-plugins/_support/argv-log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The stubbed plugin (IP-WU-060) is not in any plugins root by default; the
// e2e-harness and e2e-flow specs need it discoverable so they can drive it
// per-scenario via /test/__reset. Pointing ROUBO_USER_PLUGINS_DIR at
// `e2e/fixtures/` lets the plugin-manager walk into `stubbed-plugin/` and
// register it as the `e2e-stub` plugin alongside the bundled overlays.
const E2E_USER_PLUGINS_DIR = path.resolve(__dirname, "e2e", "fixtures");
// IP-WU-068: the project-settings specs need the github-com / ghe /
// jira-self-hosted plugin slots to surface scenario-pinned data instead of
// making real API calls. Pointing ROUBO_BUNDLED_PLUGINS_DIR at
// `e2e/fixtures/bundled-overlays/` swaps the bundled plugins for thin stubs
// whose entrypoints re-export the canonical e2e-stub runtime. The manifest
// ids stay `github-com` / `ghe` / `jira-self-hosted`, so hardcoded
// `plugin.id === ...` UI branches (PluginConfigureDialog: integration-fields
// section, OAuth section, instance handling) activate as they would in prod.
const E2E_BUNDLED_PLUGINS_DIR = path.resolve(__dirname, "e2e", "fixtures", "bundled-overlays");
// AP-TC-087 (#1083): the `claude-code` bundled overlay's launch descriptor and
// version probe both name `roubo-e2e-claude-stub`, which lives here. Prepending
// this directory to the server's PATH is what makes the stub resolvable to
// `resolveAgentCommand` (and to the probe) without installing anything. The stub
// is deliberately NOT named `claude`, so prepending cannot shadow a real CLI.
// AP-TC-113 (#1095) adds a second pair on the same wiring: the `codex-cli`
// overlay and `roubo-e2e-codex-stub`, and AP-TC-115 (#1127) a third, `gemini-cli`
// and `roubo-e2e-gemini-stub`, APCC-TC-022 (#1306) a fourth,
// `agent-choice-probe` and `roubo-e2e-probe-stub`, and APCC-TC-038 (#1349) a
// fifth, `cursor-cli` and `roubo-e2e-cursor-stub`. Both hooks are directory
// walks, so a new overlay directory and a new stub file are picked up with no
// config change.
const E2E_FIXTURE_BIN_DIR = path.resolve(__dirname, "e2e", "fixtures", "bin");

// Four surfaces share one config:
//   - dev-fixture: drives Vite-served component fixtures (the Enable-plugin
//     prompt) against the dev server. Dev-mode only.
//   - e2e-harness: drives the BUILT Roubo app (server serving the built client
//     via express.static) with ROUBO_E2E=1 enabling POST /test/__reset. Holds
//     the IP-WU-064 harness-shape specs (smoke, determinism, gate behaviour).
//   - e2e-flow: same built-app surface, holds the IP-WU-063 user-flow specs
//     (IP-TC-156..IP-TC-160). Each spec pins the stubbed plugin to a dedicated
//     scenario + frozen-now via /test/__reset.
//   - e2e-plugin-grid: same built-app surface, holds the IP-WU-065 plugin-grid
//     responsive-layout spec (IP-TC-170). Relies on the four sibling stubbed
//     plugin fixtures (e2e-stub-2..e2e-stub-5) being present alongside the
//     canonical e2e-stub under e2e/fixtures/ so the Settings > Plugins grid
//     renders the five cards the spec asserts column wrap against.
//   - connection-status: same built-app surface, holds the IP-WU-064 specs
//     (IP-TC-168 three-placement surfacing, IP-TC-169 auth-problem flip).
//   - cut-list-ui: same built-app surface, holds the IP-WU-067 specs
//     (IP-TC-173..IP-TC-176 cut-list filtering, facets, chip taxonomy). Each spec
//     pins the stubbed plugin to a dedicated scenario + frozen-now.
//   - e2e-alerts: same built-app surface, holds the per-category
//     test-connection spec (IP-TC-167 alerts scope-missing result strip).
//   - component-plugins: same built-app surface, holds the CP-TC-028 (#662)
//     component-plugin deploy-journey drift guard. Relies on the
//     `clasp-deploy-stub` imperative component plugin fixture being present
//     and built under e2e/fixtures/ so plugin-manager discovers it via
//     ROUBO_USER_PLUGINS_DIR, and on `/test/__register-fixture-project`'s
//     `componentPlugin` option to bind a `deploy` component to it.
//   - agent-plugins: same built-app surface, holds the AP-TC-087 (#1083)
//     configure-Claude-then-launch drift guard. Relies on the `claude-code`
//     bundled overlay under ROUBO_BUNDLED_PLUGINS_DIR (an agent-kind stub whose
//     configSchema mirrors the real plugin) plus the `roubo-e2e-claude-stub`
//     binary on the server's PATH, which captures the spawned child's own argv
//     to AGENT_ARGV_LOG_PATH whenever ROUBO_E2E_AGENT_ARGV_LOG is set.
//     A second agent-kind overlay, `codex-cli` with `roubo-e2e-codex-stub`
//     (#1095, #1128), sits alongside it and carries the AP-TC-056 / AP-TC-105
//     configure-Codex-then-launch drift guard. It mirrors the shipped Codex
//     plugin's configSchema, argv mapping and quiescence window, and its stub
//     captures argv to its OWN CODEX_ARGV_LOG_PATH under the same
//     ROUBO_E2E_AGENT_ARGV_LOG gate, so the two guards' evidence cannot race.
//     It is installed but UNCONSENTED and force-disabled by every
//     `/test/__reset` unless a spec opts in, which keeps
//     `resolveLaunchAgentId`'s lone-available-agent fallback on Claude Code.
//     A third agent-kind overlay, `gemini-cli` with `roubo-e2e-gemini-stub`
//     (#1127), sits alongside both for the AP-TC-115 marketplace-install-to-
//     launch guard. It is the only one of the three declaring a configSchema
//     (S005 asks for a schema-rendered form), and its property keys deliberately
//     avoid the claude-code overlay's model / effort / mode / extraArgs so the
//     page-wide `config-field-*` count AP-TC-087 reads cannot move. Like
//     `codex-cli` it is force-disabled by every /test/__reset and its stub never
//     writes the argv log.
//     A fourth, `agent-choice-probe` with `roubo-e2e-probe-stub` (#1306), backs
//     the APCC-TC-022 axe audit of the AI Agents screen. Its `probedModel`
//     field is populated by a choice probe that runs the stub, and the stub
//     reads a mode file (PROBE_MODE_PATH, e2e/agent-plugins/_support/
//     probe-mode-path.mjs) to answer resolved, slow or failed. The path is a
//     constant rather than an env var, because the probe spawn strips every
//     ROUBO_* variable and an env value must not steer a filesystem path, so no
//     config change is needed here. /test/__reset empties the probe cache so
//     each test's mode is read afresh, and force-disables the overlay.
//     A fifth, `cursor-cli` with `roubo-e2e-cursor-stub` (#1349), backs the
//     APCC-TC-038 set-a-posture-and-rules-then-launch guard. It mirrors the
//     shipped Cursor plugin's posture table, its two rule tiers and its
//     `.cursor/cli.json` rules write, and its stub captures argv to its OWN
//     CURSOR_ARGV_LOG_PATH under the ROUBO_E2E_AGENT_ARGV_LOG gate. It is
//     force-disabled by every /test/__reset like `codex-cli`. The same overlay
//     also carries the APCC-TC-011 configure-a-Cursor-model guard: it mirrors
//     the shipped `model` field, its `choiceProbes` entry and the model and
//     extra-arguments half of the argv mapping, and the stub answers
//     `--list-models` with an excerpt of a real model listing. The APCC-TC-052
//     version-gate guard reuses the pair too: the stub reads a build file
//     (CURSOR_VERSION_PATH, e2e/agent-plugins/_support/cursor-version-path.mjs)
//     to report a build below the floor or inside the window, on the same
//     constant-path terms as PROBE_MODE_PATH. So does the APCC-TC-046
//     completed-turn notification guard: the overlay mirrors the shipped
//     plugin's file-registered `stop` hook and its quiescence fallback, and the
//     stub runs that hook when the spec drops a finish-turn file into the bench
//     worktree. The APCC-TC-031 / APCC-TC-056 jig-session and catalog-install
//     guard reuses all of that: the stub also writes its working directory to
//     CURSOR_CWD_LOG_PATH under the same gate, and the e2e catalog fixture
//     (server/services/catalog-client.ts) lists the overlay as a `cursor-cli`
//     agent-kind entry.
//   - hot-reload: same built-app surface, holds the HR-TC-001 / HR-TC-045
//     save-roubo.yaml journey drift guard and the HR-TC-002 stale-bench
//     journey drift guard. Both edit a fixture project's roubo.yaml on disk
//     while the server runs; HR-TC-001 / HR-TC-045 read the server's
//     `[input-watcher]` apply lines through GET /test/__input-watcher-log.
//     Their bench legs rely on the `process` component overlay under
//     ROUBO_BUNDLED_PLUGINS_DIR, which mirrors the real plugin's translate
//     mapping. Every fixture project binds a component to `process`, so the
//     overlay is force-disabled by every /test/__reset, and each spec enables
//     and consents it before it sets up a bench. The HR-TC-012 plugin-update
//     journey drift guard installs and then updates `database` through the
//     marketplace, from fixture packages the e2e catalog serves
//     (POST /test/__serve-catalog-package, e2e/fixtures/catalog-packages/),
//     while a bench runs its Redis container. It needs Docker, and skips
//     with the reason when the runner has none. The HR-TC-026 hand-add
//     journey drift guard appends a project to projects.json from outside
//     the app, in the state dir that GET /test/__state-dir names, and reads
//     its cut list from the stubbed plugin's
//     `hot-reload-hand-added-project` scenario.
//   - project-settings: same built-app surface, holds the IP-WU-068 specs
//     (IP-TC-177/178/179/182). These rely on the `bundled-overlays/` stub
//     plugins replacing the real github-com / ghe / jira-self-hosted under
//     ROUBO_BUNDLED_PLUGINS_DIR, plus `/test/__register-fixture-project` to
//     hand each spec a registered project pointing at the right overlay.
//   - hot-reload-hardening: same surface as hot-reload, holds the cases that
//     take minutes or measure a budget: the HR-TC-048 save-to-UI latency, the
//     HR-TC-049 idle CPU and the HR-TC-051 fuzz of invalid inputs. Each skips
//     unless ROUBO_E2E_HARDENING=1, so a plain `playwright test` stays fast;
//     the perf workflow runs them nightly (.github/workflows/perf.yml).
//
// The run mode (HR-TC-053), from E2E_RUN_MODE:
//   - built (the default): the built server, `npm run start -w server`,
//     serving the built client.
//   - dev: the server as `npm run dev` runs it, from source under `tsx watch`,
//     and the client from the Vite dev server, whose proxy targets the server
//     under test. The hot-reload projects then drive the Vite URL.
//   - packaged: the server bundle of the packaged app, run on the packaged
//     app's own executable (e2e/_support/packaged-server.mjs), with its state
//     under ~/.roubo of a throwaway HOME. E2E_PACKAGED_APP names the packaged
//     app folder under electron/out/ (the folder holding Roubo.app, or the
//     Linux app folder), by name; without it the first app there is used.
// The reload-suite workflow (.github/workflows/reload-suite.yml) runs the
// hot-reload project in each mode.
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 3334);
const SERVER_PORT = Number(process.env.E2E_SERVER_PORT ?? 3336);
const DEV_BASE_URL = `http://localhost:${DEV_PORT}`;
const SERVER_BASE_URL = `http://localhost:${SERVER_PORT}`;

type RunMode = "built" | "dev" | "packaged";

function runModeOf(value: string | undefined): RunMode {
  if (value === undefined || value === "" || value === "built") return "built";
  if (value === "dev" || value === "packaged") return value;
  throw new Error(`E2E_RUN_MODE must be built, dev or packaged, not ${JSON.stringify(value)}`);
}

const RUN_MODE = runModeOf(process.env.E2E_RUN_MODE);

/** The packaged app's executable and server entry, for the packaged run mode. */
function packagedServer(): { executable: string; entry: string } {
  const outDir = path.resolve(__dirname, "electron", "out");
  // The app is a folder of electron/out/, by name: a name is matched against a
  // fixed pattern and the resolved path must stay inside the out dir, so no
  // value of the environment points the run anywhere else.
  const APP_NAME_RE = /^Roubo-(darwin|linux)-[A-Za-z0-9._-]+$/;
  const requested = process.env.E2E_PACKAGED_APP;
  if (requested && !APP_NAME_RE.test(requested)) {
    throw new Error(
      `E2E_PACKAGED_APP must name an app folder of electron/out/ such as Roubo-darwin-arm64, not ${JSON.stringify(requested)}`,
    );
  }
  const found =
    requested ||
    (fs.existsSync(outDir)
      ? fs.readdirSync(outDir).find((name) => APP_NAME_RE.test(name))
      : undefined);
  if (!found) {
    throw new Error(
      "E2E_RUN_MODE=packaged needs a packaged app: run `npm run package --prefix electron` or set E2E_PACKAGED_APP to its folder name under electron/out/",
    );
  }
  const appDir = path.resolve(outDir, found);
  if (path.dirname(appDir) !== outDir) {
    throw new Error(`the packaged app ${found} is not inside electron/out/`);
  }
  const macApp = path.join(appDir, "Roubo.app");
  if (fs.existsSync(macApp)) {
    return {
      executable: path.join(macApp, "Contents", "MacOS", "roubo"),
      entry: path.join(
        macApp,
        "Contents",
        "Resources",
        "app.asar",
        "resources",
        "server",
        "dist",
        "index.js",
      ),
    };
  }
  return {
    executable: path.join(appDir, "roubo"),
    entry: path.join(appDir, "resources", "app.asar", "resources", "server", "dist", "index.js"),
  };
}

function serverCommand(mode: RunMode): string {
  if (mode === "dev") return "npm run dev:server";
  if (mode === "packaged") {
    const { executable, entry } = packagedServer();
    const launcher = path.resolve(__dirname, "e2e", "_support", "packaged-server.mjs");
    return `"${executable}" "${launcher}" "${entry}"`;
  }
  return "npm run start -w server";
}

// The URL the hot-reload projects drive: in dev mode the Vite dev server, which
// proxies /api, /ws and /test to the server under test.
const RELOAD_BASE_URL = RUN_MODE === "dev" ? DEV_BASE_URL : SERVER_BASE_URL;

// The env of the packaged run: the app's executable runs as plain Node, and the
// e2e harness may use the production state of the throwaway HOME.
const RUN_MODE_ENV: Record<string, string> =
  RUN_MODE === "packaged" ? { ELECTRON_RUN_AS_NODE: "1", ROUBO_E2E_PACKAGED: "1" } : {};

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  // Single worker so that parallel spec files cannot race POST /test/__reset
  // against each other (the second concurrent reset would see plugin-manager
  // mid-initialize and throw "already initialized"). IP-NFR-018 calls for
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
      testMatch: ["enable-plugin-prompt.spec.ts"],
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
    {
      name: "component-plugins",
      testMatch: ["component-plugins/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "agent-plugins",
      testMatch: ["agent-plugins/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: SERVER_BASE_URL },
    },
    {
      name: "hot-reload",
      testMatch: ["hot-reload/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: RELOAD_BASE_URL },
    },
    {
      name: "hot-reload-hardening",
      testMatch: ["hot-reload-hardening/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"], baseURL: RELOAD_BASE_URL },
    },
  ],
  webServer: [
    {
      command: "npm run dev:client",
      // In dev mode the Vite proxy targets the server under test.
      env: {
        DEV_PORT: String(DEV_PORT),
        ...(RUN_MODE === "dev" ? { DEV_API_PORT: String(SERVER_PORT) } : {}),
      },
      url: DEV_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: serverCommand(RUN_MODE),
      env: {
        ...RUN_MODE_ENV,
        ROUBO_PORT: String(SERVER_PORT),
        ROUBO_E2E: "1",
        ROUBO_USER_PLUGINS_DIR: E2E_USER_PLUGINS_DIR,
        ROUBO_BUNDLED_PLUGINS_DIR: E2E_BUNDLED_PLUGINS_DIR,
        // AP-TC-087 (#1083): make `roubo-e2e-claude-stub` resolvable, and switch on
        // its argv capture. `importLoginShellEnv()` merges the login shell's PATH by
        // prepending only entries this value does not already carry, so the fixture
        // dir survives that merge.
        PATH: [E2E_FIXTURE_BIN_DIR, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
        ROUBO_E2E_AGENT_ARGV_LOG: AGENT_ARGV_LOG_PATH,
        // Neutralise host-app env inherited by bench terminals (issue #877):
        // with ROUBO_PRODUCTION set, the server under test would resolve state
        // to the real ~/.roubo and startServer now refuses to boot alongside
        // ROUBO_E2E. Every consumer is a truthiness check, so empty strings
        // override the inherited values (Playwright merges this env over the
        // parent's).
        ROUBO_PRODUCTION: "",
      },
      url: SERVER_BASE_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
