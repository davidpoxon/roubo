import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { MarketplaceListing, PluginRecord } from "@roubo/shared";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  clearCapturedCursorArgv,
  clearCapturedCursorCwd,
  readCapturedCursorArgv,
  readCapturedCursorCwd,
} from "./_support/argv-log.js";
import {
  CURSOR_AGENT_NAME,
  CURSOR_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  createProjectJig,
  disablePlugin,
  enablePlugin,
  readAgentConfig,
  readBenchWorkspacePath,
  readBenches,
  setAgentConfig,
  setAppAgentTools,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";
import { clearCursorBuild } from "./_support/cursor-version.js";

// One FR-020 observer per case, so each divergence block names the case whose
// step diverged.
const observeLaunch = makeObserve("APCC-TC-031");
const observeInstall = makeObserve("APCC-TC-056");

// APCC-TC-031 and APCC-TC-056: a developer launches a Cursor session in a bench
// with the jig injected, and a user installs the plugin from the catalog and
// reaches a session.
//
// The integration-level drift guard for the APCC-US-001 / APCC-US-004 journey
// (APCC-FR-007, APCC-FR-008, APCC-FR-014). It walks the authoritative e2e_flow
// steps of both cases (.specifications/agent-plugins-cursor-cli/test-cases.json
// in the product spec) as ordered, attributable observations against the REAL
// built app. On divergence each observation routes through the FR-020
// failure-output contract (see ../component-plugins/_support/step-runner.ts):
// the failure reports which step diverged, the expected-vs-actual, and the
// owning slice(s).
//
// HOW THE CURSOR PLUGIN IS PROVIDED. The shipping plugin lives in the sibling
// `roubo-plugins` repo and builds against the published SDK, so roubo's e2e
// suite cannot depend on it. The agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/cursor-cli/ takes the `cursor-cli` id and
// mirrors the shipped plugin's manifest, argv mapping, prompt capability and
// notification wiring. Its stub (e2e/fixtures/bin/roubo-e2e-cursor-stub) plays
// the Cursor CLI: it records the argv it received and the directory it runs in,
// and it finishes its turn when the spec drops a finish-turn file into its
// worktree. The overlay is force-DISABLED by every /test/__reset
// (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts), so each test opts
// in and the environment is handed back with it disabled.
//
// PARTIAL CIRCULARITY, stated plainly and inherited from the sibling Cursor
// guards: because the overlay mirrors the plugin, this guard cannot prove the
// shipped plugin's own argv mapping or hook descriptor, which roubo-plugins
// unit-covers. What it proves is everything the host does with them: the
// preset and jig resolution, the prompt reaching the spawned CLI, the spawn in
// the bench worktree, the notification route, the catalog listing, the consent
// gate, and the AI Agents form feeding the launch.
//
// THREE RECONCILIATIONS against the literal APCC-TC-056 script, all deliberate
// and all asserting SHIPPED behaviour, in the style of the AP-TC-115 guard
// (marketplace-install-launch-journey.spec.ts), which hit the same walls:
//
//   1. S001 names "the marketplace". It is the Marketplace tab of Settings,
//      whose `agent` kind filter is the case's "filter to the agent kind". The
//      listing is the `cursor-cli` entry of the e2e catalog fixture
//      (E2E_FIXTURE_ENTRIES in server/services/catalog-client.ts), whose
//      `directory` points at the overlay, so its compatibility window is the
//      one the overlay's manifest declares.
//
//   2. S003 names installing. Under the harness the overlay is discovered as a
//      bundled plugin, so the card renders the "Installed" affordance rather
//      than an Install button, and no `/test/__*` seam serves an agent artifact
//      to download (the fixture digests are placeholders). Reconciled to the
//      integrated boundaries that do exist: the consent gate is REAL and lists
//      exactly the privileges the manifest declares, approving it and enabling
//      the plugin is what turns the unavailable card into a usable one, and the
//      listing carries the pinned sha256 digest the installer verifies. The
//      real download-verify-consent-commit composition for an agent-kind entry
//      is covered in-process by
//      server/services/marketplace-agent-kind-journey.e2e.test.ts, and this
//      guard does not restate it.
//
//   3. S004 names configuring. No "Configured" status ships, so the evidence is
//      the form's "Saved." confirmation plus the defaults read back through
//      GET /api/agents/cursor-cli/config, and the launched session's argv
//      carrying the saved mode.
//
// SPEC-TEXT DRIFT. STEPS and OBSERVATIONS below carry each case's text
// verbatim. When test-cases.json is reachable at TEST_CASES_PATH, each test
// first compares its copy with the case and fails on any difference. When it is
// not, the comparison is recorded as an annotation and skipped.

const PROJECT_ID = "apcc-us-001-cursor-jig-session-journey";

// `/test/__register-fixture-project` writes `seedBenches[i]` with `id: i + 1`.
const BENCH_ID = 1;

/** The command the `cursor-cli` overlay's launch descriptor names. */
const AGENT_COMMAND = "roubo-e2e-cursor-stub";

/** The tab label the server builds for the first session of this agent. */
const AGENT_TAB_LABEL = `${CURSOR_AGENT_NAME} 1`;

/** The launch menu section every installed, available agent is listed under. */
const ALL_AGENTS_SECTION = "All agents";

/** Mirrors FINISH_TURN_FILE in e2e/fixtures/bin/roubo-e2e-cursor-stub. */
const FINISH_TURN_FILE = ".roubo-e2e-cursor-finish-turn";

/** The jig APCC-TC-031 injects, and the preset that binds it to Cursor. */
const JIG_NAME = "Cursor review pass";
const PRESET_ID = "apcc-tc-031-cursor-review-pass";
const PRESET_NAME = "Cursor review pass session";
// Long, multi-line, and full of characters a lossy path would mangle: quotes of
// both kinds, `$` and backticks a shell would expand, a backslash, a flag-shaped
// line, and non-ASCII text. The repeated section makes it long enough that a
// truncation would show, and it stays far below the overlay's declared
// maxLength of 100000, so nothing may legitimately cut it.
const JIG_SECTION = [
  "## Review pass for bench {{bench.id}}",
  "",
  "Check every \"quoted\" and 'single-quoted' string, then run `npm test` without expanding $HOME.",
  "A path like C:\\temp\\cursor stays as written, and so does --mode=ask on its own line:",
  "--mode=ask",
  "Unicode stays intact: café, naïve, 日本語, emoji 🪚.",
].join("\n");
const JIG_CONTENT = Array.from({ length: 40 }, () => JIG_SECTION).join("\n\n");

/** The Cursor defaults APCC-TC-031's precondition "installed and configured" stands for. */
const LAUNCH_CONFIG = { mode: "agent" } as const;

/** The mode APCC-TC-056 S004 saves on the form, and the label its option renders. */
const INSTALL_MODE = "plan";
const INSTALL_MODE_LABEL = "Plan";

// The compatibility window the overlay's manifest declares, copied from the
// shipped manifest.
const VERSION_FLOOR = "floor 2026.09.08";
const VERSION_CEILING = "tested <= 2026.09.15";

// The overlay's manifest declares no permission category, which is what the
// shipped manifest declares too, so the consent gate lists exactly this set.
const EXPECTED_PRIVILEGES =
  "network.hosts=[], credentials.slots=[], filesystem.paths=[], processes=false, ports=false, docker=false";

/** Each case's authoritative text. */
const TEST_CASES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.specifications/agent-plugins-cursor-cli/test-cases.json",
);

// The slices this unit is blocked by, used by the FR-020 failure-output contract
// to attribute a divergence to an owning slice. Their issues live in a tracker
// this repository does not link to, so each is named by a short descriptive
// label of what it delivers, not by its issue number or issue title. The labels
// match the sibling Cursor guards where they name the same slice. The
// journey-to-slice mapping is by requirement and story overlap, so each step
// names a conservative superset.
const SLICE = {
  hooks: { title: "Cursor CLI hook delivery investigation" },
  stdin: { title: "Notifier program reads its payload on standard input" },
  plugin: { title: "Cursor CLI plugin package and launch translation" },
  axes: { title: "Cursor session axes and worktree guard" },
  wiring: { title: "Cursor session notification wiring and quiescence fallback" },
  catalog: { title: "Cursor CLI plugin build and catalog publication" },
} as const;

/** APCC-TC-031's steps, instructions verbatim from the case. */
const LAUNCH_STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open a bench for a project with the Cursor plugin installed and configured.",
    owners: [SLICE.plugin, SLICE.catalog],
  },
  S002: {
    id: "S002",
    instruction: "Open the Terminal tab.",
    owners: [SLICE.plugin],
  },
  S003: {
    id: "S003",
    instruction: "Start the launch action.",
    owners: [SLICE.plugin, SLICE.axes],
  },
  S004: {
    id: "S004",
    instruction: "Read the first prompt the agent received.",
    owners: [SLICE.plugin],
  },
  S005: {
    id: "S005",
    instruction: "Let the agent finish a turn.",
    owners: [SLICE.wiring, SLICE.stdin, SLICE.hooks],
  },
};

/** APCC-TC-031's expected text per observation, verbatim from the case. */
const LAUNCH_OBSERVATIONS: Record<string, Record<string, string>> = {
  S001: { "S001-O01": "The bench opens." },
  S002: { "S002-O01": "A launch action for the Cursor plugin is offered." },
  S003: {
    "S003-O01": "A terminal opens.",
    "S003-O02": "The Cursor CLI runs in it.",
    "S003-O03": "The session runs in the bench worktree.",
  },
  S004: {
    "S004-O01": "The jig content was delivered as the prompt.",
    "S004-O02": "No jig text was lost.",
  },
  S005: { "S005-O01": "A waiting notification is raised for the bench." },
};

/** APCC-TC-056's steps, instructions verbatim from the case. */
const INSTALL_STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the marketplace and filter to the agent kind.",
    owners: [SLICE.catalog],
  },
  S002: {
    id: "S002",
    instruction: "Read its listing.",
    owners: [SLICE.catalog, SLICE.plugin],
  },
  S003: {
    id: "S003",
    instruction: "Install it and grant the consent it asks for.",
    owners: [SLICE.catalog, SLICE.plugin],
  },
  S004: {
    id: "S004",
    instruction: "Configure it and launch it from a bench Terminal tab.",
    owners: [SLICE.plugin, SLICE.axes, SLICE.catalog],
  },
};

/** APCC-TC-056's expected text per observation, verbatim from the case. */
const INSTALL_OBSERVATIONS: Record<string, Record<string, string>> = {
  S001: { "S001-O01": "The Cursor plugin is listed." },
  S002: { "S002-O01": "The listing shows its compatibility metadata." },
  S003: { "S003-O01": "The plugin installs." },
  S004: { "S004-O01": "A Cursor session starts." },
};

interface TerminalSessionEntry {
  id: string;
  label?: string;
  status: string;
  command?: string;
  agentPluginId?: string;
}

interface NotificationEntry {
  id: string;
  type: string;
  sourceSessionId?: string;
  metadata?: Record<string, unknown>;
}

interface DeclaredPermissions {
  network?: { hosts?: unknown[] };
  credentials?: { slots?: unknown[] };
  filesystem?: { paths?: unknown[] };
  processes?: boolean;
  ports?: boolean;
  docker?: boolean;
}

interface CaseStep {
  id: string;
  instruction: string;
  observations: { id: string; expected: string }[];
}

/** One case's steps as test-cases.json records them, or null when it is not reachable. */
function readAuthoritativeSteps(caseId: string): CaseStep[] | null {
  if (!existsSync(TEST_CASES_PATH)) return null;
  const parsed = JSON.parse(readFileSync(TEST_CASES_PATH, "utf-8")) as {
    cases: { id: string; steps: CaseStep[] }[];
  };
  // Projected onto the fields this file copies, so a key the case gains later
  // (a note, a tag) is not mistaken for drift in the text.
  return (parsed.cases.find((entry) => entry.id === caseId)?.steps ?? []).map((step) => ({
    id: step.id,
    instruction: step.instruction,
    observations: step.observations.map((o) => ({ id: o.id, expected: o.expected })),
  }));
}

/** The same shape, built from this file's copy of one case. */
function localSteps(
  steps: Record<string, JourneyStep>,
  observations: Record<string, Record<string, string>>,
): CaseStep[] {
  return Object.values(steps).map((step) => ({
    id: step.id,
    instruction: step.instruction,
    observations: Object.entries(observations[step.id] ?? {}).map(([id, expected]) => ({
      id,
      expected,
    })),
  }));
}

function describeStep(step: CaseStep | undefined): string {
  if (step === undefined) return "no such step";
  const observations = step.observations.map((o) => `${o.id} "${o.expected}"`).join("; ");
  return `"${step.instruction}" / ${observations}`;
}

/**
 * Compare this file's copy of one case with test-cases.json, or record that the
 * comparison was skipped. Spec-text drift is this file's to fix, not a slice's,
 * so it fails with its own message rather than through the slice-attributed
 * observer.
 */
function expectSpecText(
  caseId: string,
  steps: Record<string, JourneyStep>,
  observations: Record<string, Record<string, string>>,
): void {
  const authoritative = readAuthoritativeSteps(caseId);
  if (authoritative === null) {
    test.info().annotations.push({
      type: "spec-text",
      description: `${TEST_CASES_PATH} is not reachable from this checkout, so the ${caseId} step text was not compared.`,
    });
    return;
  }
  const local = localSteps(steps, observations);
  const ids = (list: CaseStep[]): string => list.map((s) => s.id).join(", ");
  expect(
    ids(local),
    `${caseId} spec-text drift: the case's step ids differ from this file's copy. Re-copy the case text.`,
  ).toBe(ids(authoritative) || "no steps (case not found)");
  for (const step of local) {
    expect(
      describeStep(step),
      `${caseId} spec-text drift at ${step.id}: this file's copy differs from the case. Re-copy the case text.`,
    ).toBe(describeStep(authoritative.find((s) => s.id === step.id)));
  }
}

/**
 * The declared privilege set as one comparable line, so the consent gate's
 * contents are asserted against one rendering of it.
 */
function summarisePrivileges(permissions: DeclaredPermissions | undefined): string {
  return [
    `network.hosts=${JSON.stringify(permissions?.network?.hosts ?? [])}`,
    `credentials.slots=${JSON.stringify(permissions?.credentials?.slots ?? [])}`,
    `filesystem.paths=${JSON.stringify(permissions?.filesystem?.paths ?? [])}`,
    `processes=${permissions?.processes === true}`,
    `ports=${permissions?.ports === true}`,
    `docker=${permissions?.docker === true}`,
  ].join(", ");
}

async function listSessions(request: APIRequestContext): Promise<TerminalSessionEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`);
  if (res.status() !== 200) return [];
  // The route answers with a bare array of TerminalSession, not an envelope.
  const body = (await res.json()) as TerminalSessionEntry[];
  return Array.isArray(body) ? body : [];
}

/**
 * Drop every terminal session on this spec's bench. Live PTY sessions are NOT
 * cleared by `/test/__reset`, so a session from an earlier run would shadow the
 * one under test and leave a heartbeating stub behind.
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/** Poll until a live Cursor session is listed on the bench, or give up after ~10s. */
async function waitForLiveCursorSession(
  request: APIRequestContext,
): Promise<{ live?: TerminalSessionEntry; seen: TerminalSessionEntry[] }> {
  let seen: TerminalSessionEntry[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    seen = await listSessions(request);
    const live = seen.find(
      (session) => session.agentPluginId === CURSOR_PLUGIN_ID && session.status === "live",
    );
    if (live !== undefined) return { live, seen };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { seen };
}

function describeSessions(sessions: TerminalSessionEntry[]): string {
  return sessions.length === 0
    ? "no terminal session was created"
    : sessions
        .map(
          (session) =>
            `${session.id}: status=${session.status}, agent=${session.agentPluginId ?? "none"}, command=${session.command ?? "none"}`,
        )
        .join("; ");
}

/** Poll until the spawned stub has written its argv, or give up after ~10s. */
async function waitForCapturedArgv(): Promise<string[] | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const argv = readCapturedCursorArgv();
    if (argv !== null) return argv;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** Poll until the spawned stub has written its working directory, or give up after ~10s. */
async function waitForCapturedCwd(): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const cwd = readCapturedCursorCwd();
    if (cwd !== null) return cwd;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

/** The bench's notifications, read through the route the bench screens use. */
async function readNotifications(request: APIRequestContext): Promise<NotificationEntry[]> {
  const bench = (await readBenches(request, PROJECT_ID)).find((entry) => entry.id === BENCH_ID);
  return (bench?.notifications ?? []) as NotificationEntry[];
}

function describeNotifications(notifications: NotificationEntry[]): string {
  return notifications.length === 0
    ? "no notifications on the bench"
    : notifications.map((n) => `${n.type} (session ${n.sourceSessionId ?? "none"})`).join("; ");
}

/** Resolve symlinks, so a tmpdir under /var and its /private/var target compare equal. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Set the app-level jig behaviour, preserving the pinned default agent. The
 * APCC-TC-025 guard turns auto-inject off and restores it afterwards; an
 * interrupted run of it must not leave this journey's jig un-injected.
 */
async function setJigSettings(
  request: APIRequestContext,
  jigs: { autoInject: boolean; autoExecute: boolean },
): Promise<void> {
  const current = (await (await request.get("/api/settings")).json()) as {
    theme?: string;
    jigs?: { defaultAgentPluginId?: string };
  };
  const res = await request.put("/api/settings", {
    data: {
      theme: current.theme ?? "dark",
      jigs: {
        ...jigs,
        ...(current.jigs?.defaultAgentPluginId != null && {
          defaultAgentPluginId: current.jigs.defaultAgentPluginId,
        }),
      },
    },
  });
  expect(res.status(), "PUT /api/settings (jig settings)").toBe(200);
}

/**
 * Click a target the journey has already TOLERATED a wait for. A bare `click()`
 * on a locator that never appeared blocks until the test times out, which loses
 * the FR-020 attribution; the observation that follows reports the missing
 * target instead.
 */
async function clickIfPresent(locator: Locator): Promise<void> {
  if ((await locator.count()) === 1) await locator.click();
}

/** One session tab, located by its short label (the tab bar's own text). */
function sessionTab(page: Page, label: string): Locator {
  // The label span's parent IS the tab: `..` walks to it without depending on
  // any styling class, and the tab carries no test id of its own.
  return page.getByText(label, { exact: true }).locator("..");
}

/**
 * Open the split button's grouped launch menu. With no sessions open the tab bar
 * and the empty state each render one chevron; the first is the one in the tab
 * bar. Every wait is TOLERATED, so a menu that never opens is reported by the
 * observation that reads it.
 */
async function openLaunchMenu(page: Page): Promise<Locator> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await clickIfPresent(trigger);
  const menu = page.getByRole("menu");
  // The menu's sections render before the agent inventory resolves, so wait on
  // a row rather than on the menu alone.
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  return menu;
}

/** Select the AI Agents settings tab on an already-loaded settings page. */
async function selectAgentsTab(page: Page): Promise<void> {
  const tab = page.getByRole("tab", { name: "AI Agents" });
  await expect(tab, "the AI Agents settings tab renders").toBeVisible();
  await tab.click();
}

test.beforeEach(async ({ request }) => {
  // Every tolerated wait is time an observation may take before it reports a
  // divergence, and on a failing run they add up past the 30s default. A budget
  // that expired mid-step would replace the FR-020 block with a bare timeout.
  test.setTimeout(120_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // App-level agent defaults and presets are NOT among the files /test/__reset
  // truncates, so a previous run's would survive into this one (NFR-018).
  await clearAgentConfig(request, CURSOR_PLUGIN_ID);
  await setAppAgentTools(request, []);
  await setJigSettings(request, { autoInject: true, autoExecute: true });
  // Pinned explicitly rather than left to the lone-available-agent fallback,
  // which a second enabled agent removes. A settings write only: the overlay is
  // still disabled here.
  await setDefaultAgent(request, CURSOR_PLUGIN_ID);

  // Precondition: a project with an active bench. A seeded bench carries a real
  // tmpdir workspace, which is all `isBenchOperable` asks of it.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 31,
            integrationId: "github-com",
            externalId: "31",
            title: "Launch a Cursor session with the jig injected",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  clearCapturedCursorArgv();
  clearCapturedCursorCwd();
  // The APCC-TC-052 journey writes a below-the-floor build into the stub's
  // version file. Cleared so an interrupted run of it cannot block this launch.
  clearCursorBuild();
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  const workspace = await readBenchWorkspacePath(request, PROJECT_ID, BENCH_ID).catch(() => null);
  if (workspace !== null) rmSync(join(workspace, FINISH_TURN_FILE), { force: true });
  await setAppAgentTools(request, []);
  await setDefaultAgent(request, null);
  await clearAgentConfig(request, CURSOR_PLUGIN_ID);
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, CURSOR_PLUGIN_ID);
  clearCapturedCursorArgv();
  clearCapturedCursorCwd();
});

test(
  "APCC-TC-031: a developer launches a Cursor session in a bench with the jig injected (S001-S005)",
  { tag: "@APCC-TC-031" },
  async ({ page, request }) => {
    expectSpecText("APCC-TC-031", LAUNCH_STEPS, LAUNCH_OBSERVATIONS);

    // Precondition: the Cursor plugin is installed, enabled, consented and
    // configured. `resolveAgent` refuses an unconsented agent, so without
    // consent the launch would 403.
    await enablePlugin(request, CURSOR_PLUGIN_ID);
    await consentAgent(request, CURSOR_PLUGIN_ID);
    await waitForAvailableAgents(request, [CURSOR_PLUGIN_ID]);
    await setAgentConfig(request, CURSOR_PLUGIN_ID, { ...LAUNCH_CONFIG });

    // The jig and the preset that launches it. A project jig lives in the
    // fixture repo's own tmpdir, so the next reset drops it with the project;
    // the preset is app-level and is cleared in afterEach.
    const jig = await createProjectJig(request, PROJECT_ID, {
      name: JIG_NAME,
      description: "Review the workspace, keeping every character of the brief",
      content: JIG_CONTENT,
      agentPluginId: CURSOR_PLUGIN_ID,
    });
    // The prompt the launch has to carry: the jig's content AS STORED (the
    // writer normalises the markdown body) with its template resolved.
    const expectedPrompt = jig.content.replaceAll("{{bench.id}}", String(BENCH_ID));
    await setAppAgentTools(request, [
      { id: PRESET_ID, name: PRESET_NAME, agent: CURSOR_PLUGIN_ID, params: {}, jig: jig.id },
    ]);
    const workspace = await readBenchWorkspacePath(request, PROJECT_ID, BENCH_ID);

    // --- S001: open the bench ---------------------------------------------------
    const benchRes = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
    const terminalTab = page.getByRole("tab", { name: "Terminal" });
    // A TOLERATED wait, not an assertion, so a bench that never renders is
    // reported through S001-O01 rather than as an unattributed timeout.
    await terminalTab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const terminalTabCount = await terminalTab.count();
    observeLaunch(
      LAUNCH_STEPS.S001,
      "S001-O01",
      benchRes?.status() === 200 && terminalTabCount === 1,
      `${LAUNCH_OBSERVATIONS.S001["S001-O01"]} GET /projects/${PROJECT_ID}/benches/${BENCH_ID} answers 200 and the bench view renders its Terminal tab.`,
      `status=${benchRes?.status() ?? "no response"}, Terminal tab count=${terminalTabCount}`,
    );

    // --- S002: open the Terminal tab; a Cursor launch action is offered --------
    await clickIfPresent(terminalTab);
    const menu = await openLaunchMenu(page);
    const presetRow = menu.getByTestId(`launch-preset-${PRESET_ID}`);
    await presetRow.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const presetRowCount = await presetRow.count();
    const presetRowText = presetRowCount === 1 ? ((await presetRow.textContent()) ?? "") : "";
    observeLaunch(
      LAUNCH_STEPS.S002,
      "S002-O01",
      presetRowCount === 1 && presetRowText.includes(PRESET_NAME),
      `${LAUNCH_OBSERVATIONS.S002["S002-O01"]} The launch menu offers the "${PRESET_NAME}" preset, which launches ${CURSOR_AGENT_NAME} with the "${JIG_NAME}" jig.`,
      `preset row count=${presetRowCount}, text=${JSON.stringify(presetRowText)}`,
    );

    // --- S003: start the launch action ------------------------------------------
    await clickIfPresent(presetRow);
    const { live, seen } = await waitForLiveCursorSession(request);
    const agentTab = sessionTab(page, AGENT_TAB_LABEL);
    await agentTab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const agentTabCount = await agentTab.count();
    observeLaunch(
      LAUNCH_STEPS.S003,
      "S003-O01",
      live !== undefined && agentTabCount === 1,
      `${LAUNCH_OBSERVATIONS.S003["S003-O01"]} A PTY session is live on the bench (agentPluginId=${CURSOR_PLUGIN_ID}) and a tab labelled "${AGENT_TAB_LABEL}" appears.`,
      `session: ${live ? `${live.id} live` : describeSessions(seen)}; tabs labelled "${AGENT_TAB_LABEL}": ${agentTabCount}`,
    );
    const sessionId = live?.id ?? "";

    const argv = await waitForCapturedArgv();
    observeLaunch(
      LAUNCH_STEPS.S003,
      "S003-O02",
      live?.command === AGENT_COMMAND && argv !== null,
      `${LAUNCH_OBSERVATIONS.S003["S003-O02"]} The session runs the CLI the plugin's descriptor names, "${AGENT_COMMAND}", and that child ran (it recorded its argv).`,
      `session command=${live?.command ?? "no session"}, argv ${argv === null ? "never recorded" : "recorded"}`,
    );

    // No API surface reports a session's working directory, so the child's own
    // `process.cwd()` is the evidence, compared after resolving symlinks.
    const cwd = await waitForCapturedCwd();
    observeLaunch(
      LAUNCH_STEPS.S003,
      "S003-O03",
      cwd !== null && realPath(cwd) === realPath(workspace),
      `${LAUNCH_OBSERVATIONS.S003["S003-O03"]} The CLI's working directory is the bench worktree, ${realPath(workspace)}.`,
      cwd === null ? "the child never recorded a working directory" : `cwd=${realPath(cwd)}`,
    );

    // --- S004: the first prompt the agent received ------------------------------
    // The child's OWN argv is the evidence: the overlay declares an
    // argv-positional prompt, so the jig arrives as the final positional after
    // every generated flag. With mode=agent and no model or extra arguments the
    // plugin generates no flags, so the prompt is the whole argv.
    const captured = argv ?? [];
    const prompt = captured.at(-1);
    observeLaunch(
      LAUNCH_STEPS.S004,
      "S004-O01",
      prompt === expectedPrompt,
      `${LAUNCH_OBSERVATIONS.S004["S004-O01"]} The final argv positional is the "${JIG_NAME}" jig's stored content with {{bench.id}} resolved to ${BENCH_ID} (${expectedPrompt.length} chars).`,
      prompt === undefined
        ? `no argv was captured: ${JSON.stringify(captured)}`
        : `final positional (${prompt.length} chars) starts ${JSON.stringify(prompt.slice(0, 80))}`,
    );
    // Lossless means the whole jig arrived in ONE argv entry: not split into
    // words, not cut short, and not followed by anything else.
    const expectedChars = [...expectedPrompt];
    const promptChars = [...(prompt ?? "")];
    const firstMismatch =
      prompt === undefined
        ? -1
        : expectedChars.findIndex((char, index) => promptChars[index] !== char);
    observeLaunch(
      LAUNCH_STEPS.S004,
      "S004-O02",
      captured.length === 1 && prompt === expectedPrompt,
      `${LAUNCH_OBSERVATIONS.S004["S004-O02"]} The argv is exactly one entry, the full ${expectedPrompt.length}-char prompt, every quote, $, backtick, backslash, newline and non-ASCII character intact.`,
      `argv entries=${captured.length}, prompt length=${prompt?.length ?? 0}` +
        (firstMismatch >= 0 ? `, first differing character at code point ${firstMismatch}` : ""),
    );

    // --- S005: the agent finishes a turn ----------------------------------------
    // The developer steps away first. TerminalTabs dismisses the active tab's
    // notifications while it is on screen, by design, so a turn finishing under
    // the open session tab would raise the notification and clear it on the
    // next poll. Leaving the bench view is the situation the notification
    // exists for, and keeps the raise observable.
    await page.goto("about:blank");
    // Whatever the bench already carries is the baseline, so only a notification
    // raised after the turn counts.
    const before = new Set((await readNotifications(request)).map((n) => n.id));
    writeFileSync(join(workspace, FINISH_TURN_FILE), "finish\n", "utf-8");
    let raised: NotificationEntry | undefined;
    let notifications: NotificationEntry[] = [];
    for (let attempt = 0; attempt < 150 && raised === undefined; attempt += 1) {
      notifications = await readNotifications(request);
      raised = notifications.find(
        (n) => n.type === "agent-waiting" && n.sourceSessionId === sessionId && !before.has(n.id),
      );
      if (raised === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    observeLaunch(
      LAUNCH_STEPS.S005,
      "S005-O01",
      raised !== undefined && sessionId !== "",
      `${LAUNCH_OBSERVATIONS.S005["S005-O01"]} An agent-waiting notification for session ${sessionId || "(none)"} is raised on bench ${BENCH_ID} after the turn finished.`,
      describeNotifications(notifications),
    );
  },
);

test(
  "APCC-TC-056: a user installs the Cursor plugin from the catalog and reaches a session (S001-S004)",
  { tag: "@APCC-TC-056" },
  async ({ page, request }) => {
    expectSpecText("APCC-TC-056", INSTALL_STEPS, INSTALL_OBSERVATIONS);

    // The overlay is force-disabled by the reset, which is the harness's
    // stand-in for "not installed yet": the journey's own S003 enables it.

    // The pre-install half of S003, read while the plugin is still disabled: its
    // AI Agents card carries the unavailable notice.
    const settingsRes = await page.goto("/settings#ai-agents");
    expect(settingsRes?.status(), "GET /settings").toBe(200);
    await selectAgentsTab(page);
    const installed = page.getByRole("region", { name: "Installed agent plugins" });
    const unavailable = page.getByTestId(`agent-unavailable-${CURSOR_PLUGIN_ID}`);
    await unavailable.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const preInstallUnavailable = await unavailable.count();

    // --- S001: the marketplace, filtered to the agent kind ----------------------
    // `exact` matters, because a "Marketplaces" (source registry) tab sits
    // beside it.
    const marketplaceTab = page.getByRole("tab", { name: "Marketplace", exact: true });
    await expect(marketplaceTab, "the Marketplace settings tab renders").toBeVisible();
    await marketplaceTab.click();
    const agentFilter = page.getByTestId("marketplace-filter-agent");
    await agentFilter.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    await clickIfPresent(agentFilter);
    // Wait for the FILTERED render to land. The catalog query holds
    // `placeholderData: keepPreviousData` (client/src/hooks/useMarketplace.ts),
    // so the grid keeps the unfiltered cards while the request is in flight.
    await page
      .locator('[data-testid="marketplace-card-kind"]:not([data-kind="agent"])')
      .first()
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => {});

    const card = page.locator(
      `[data-testid="marketplace-card"][data-plugin-id="${CURSOR_PLUGIN_ID}"]`,
    );
    await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const cardCount = await card.count();
    const kindChip = card.getByTestId("marketplace-card-kind");
    const kind = cardCount === 1 ? await kindChip.getAttribute("data-kind") : null;
    const renderedIds = await page
      .locator('[data-testid="marketplace-card"]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-plugin-id")));
    // Cross-checked against the agent-kind listing the server serves, so a
    // filter that ignored the kind would still be caught.
    const listingsRes = await request.get("/api/marketplace/plugins?kind=agent");
    expect(listingsRes.status(), "GET /api/marketplace/plugins?kind=agent").toBe(200);
    const agentListings =
      ((await listingsRes.json()) as { listings?: MarketplaceListing[] }).listings ?? [];
    const serverListed = agentListings.some((listing) => listing.id === CURSOR_PLUGIN_ID);
    observeInstall(
      INSTALL_STEPS.S001,
      "S001-O01",
      cardCount === 1 &&
        kind === "agent" &&
        serverListed &&
        renderedIds.every((id) => agentListings.some((listing) => listing.id === id)),
      `${INSTALL_OBSERVATIONS.S001["S001-O01"]} Under the agent filter the Marketplace renders one ${CURSOR_AGENT_NAME} card with an 'agent' kind chip, and every rendered card is an agent-kind listing the server serves.`,
      `${CURSOR_AGENT_NAME} card count=${cardCount}, data-kind=${JSON.stringify(kind)}, rendered=${JSON.stringify(renderedIds)}, server agent listings=${JSON.stringify(agentListings.map((l) => l.id))}`,
    );

    // --- S002: the listing's compatibility metadata -----------------------------
    const compatibility = card.getByTestId("marketplace-card-agent-compatibility");
    const compatibilityCount = cardCount === 1 ? await compatibility.count() : 0;
    const compatibilityText =
      compatibilityCount === 1 ? ((await compatibility.textContent()) ?? "") : "";
    const declared =
      compatibilityCount === 1 ? await compatibility.getAttribute("data-declared") : null;
    observeInstall(
      INSTALL_STEPS.S002,
      "S002-O01",
      declared === "true" &&
        compatibilityText.includes(VERSION_FLOOR) &&
        compatibilityText.includes(VERSION_CEILING),
      `${INSTALL_OBSERVATIONS.S002["S002-O01"]} The card shows the declared version floor and tested ceiling: "${VERSION_FLOOR}" and "${VERSION_CEILING}".`,
      compatibilityCount === 1
        ? `data-declared=${JSON.stringify(declared)}, rendered=${JSON.stringify(compatibilityText)}`
        : "the listing rendered no agent-compatibility line",
    );

    // --- S003: install it and grant the consent it asks for ---------------------
    const consentRes = await request.get(`/api/plugins/${CURSOR_PLUGIN_ID}/consent`);
    expect(consentRes.status(), `GET /api/plugins/${CURSOR_PLUGIN_ID}/consent`).toBe(200);
    const consentBody = (await consentRes.json()) as { declared?: DeclaredPermissions };
    const declaredPrivileges = summarisePrivileges(consentBody.declared);
    await consentAgent(request, CURSOR_PLUGIN_ID);
    // The harness's analogue of the install commit: enabling the force-disabled
    // overlay is what turns an inert record into a running, resolvable agent.
    await enablePlugin(request, CURSOR_PLUGIN_ID);
    await waitForAvailableAgents(request, [CURSOR_PLUGIN_ID]);

    const listing = agentListings.find((entry) => entry.id === CURSOR_PLUGIN_ID);
    const pluginsRes = await request.get("/api/plugins");
    expect(pluginsRes.status(), "GET /api/plugins").toBe(200);
    const record = (((await pluginsRes.json()) as { plugins?: PluginRecord[] }).plugins ?? []).find(
      (plugin) => plugin.id === CURSOR_PLUGIN_ID,
    );
    // Consent and enable were recorded through the API, so the screen is re-read
    // before the card can reflect them.
    const reloaded = await page.reload();
    expect(reloaded?.status(), "reload /settings").toBe(200);
    await selectAgentsTab(page);
    const agentCard = installed.getByTestId(`agent-plugin-card-${CURSOR_PLUGIN_ID}`);
    await agentCard.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const agentCardCount = await agentCard.count();
    const postInstallUnavailable = await unavailable.count();
    observeInstall(
      INSTALL_STEPS.S003,
      "S003-O01",
      declaredPrivileges === EXPECTED_PRIVILEGES &&
        /^sha256-[0-9a-f]{64}$/.test(listing?.integrity ?? "") &&
        record?.status === "enabled" &&
        preInstallUnavailable === 1 &&
        agentCardCount === 1 &&
        postInstallUnavailable === 0,
      `${INSTALL_OBSERVATIONS.S003["S003-O01"]} The consent gate lists exactly the declared privileges (${EXPECTED_PRIVILEGES}), the listing carries a pinned sha256 digest, and once consent is granted the plugin is enabled and its AI Agents card loses the unavailable notice it carried before.`,
      `declared=${declaredPrivileges}, integrity=${listing?.integrity ?? "no listing"}, plugin status=${record?.status ?? "no record"}, unavailable notice before=${preInstallUnavailable}, card count after=${agentCardCount}, unavailable notice after=${postInstallUnavailable}`,
    );

    // --- S004: configure it, then launch it from a bench Terminal tab -----------
    const form = page.getByTestId(`agent-config-form-${CURSOR_PLUGIN_ID}`);
    const disclosure = page.getByTestId(`agent-configure-${CURSOR_PLUGIN_ID}`);
    // The card mounts with its disclosure open; open it only if it is not.
    if ((await form.count()) === 0) await clickIfPresent(disclosure);
    await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    // React Aria's Select renders the trigger as a Button inside the testid'd
    // root and portals its ListBox to the document body, so the option is
    // located at page level.
    await form
      .getByTestId("config-field-mode")
      .locator("button")
      .click({ timeout: 15_000 })
      .catch(() => {});
    await page
      .getByRole("option", { name: INSTALL_MODE_LABEL, exact: true })
      .click({ timeout: 15_000 })
      .catch(() => {});
    const save = page.getByTestId(`agent-config-save-${CURSOR_PLUGIN_ID}`);
    await save.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if (await save.isEnabled().catch(() => false)) await save.click();
    const savedNotice = form.getByText("Saved.");
    await savedNotice.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const savedNoticeCount = await savedNotice.count();
    const persisted = await readAgentConfig(request, CURSOR_PLUGIN_ID);

    const benchRes = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
    expect(benchRes?.status(), "GET the bench detail page").toBe(200);
    const terminalTab = page.getByRole("tab", { name: "Terminal" });
    await expect(terminalTab, "the bench detail view has a Terminal tab").toBeVisible();
    await terminalTab.click();
    await openLaunchMenu(page);
    const row = page
      .getByRole("group", { name: ALL_AGENTS_SECTION })
      .getByRole("menuitem", { name: new RegExp(`^${CURSOR_AGENT_NAME}:`) });
    await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const rowCount = await row.count();
    await clickIfPresent(row);

    const { live, seen } = await waitForLiveCursorSession(request);
    const argv = live === undefined ? null : await waitForCapturedArgv();
    const captured = argv ?? [];
    const modeIndex = captured.findIndex(
      (token, index) => token === "--mode" && captured[index + 1] === INSTALL_MODE,
    );
    observeInstall(
      INSTALL_STEPS.S004,
      "S004-O01",
      persisted.mode === INSTALL_MODE &&
        savedNoticeCount === 1 &&
        rowCount === 1 &&
        live !== undefined &&
        live.command === AGENT_COMMAND &&
        modeIndex >= 0,
      `${INSTALL_OBSERVATIONS.S004["S004-O01"]} The form saves mode=${INSTALL_MODE} ("Saved."), the bench launch menu lists ${CURSOR_AGENT_NAME} under "${ALL_AGENTS_SECTION}", and launching it opens a live session running "${AGENT_COMMAND}" whose argv carries --mode ${INSTALL_MODE}.`,
      `saved mode=${JSON.stringify(persisted.mode)}, save confirmation count=${savedNoticeCount}, launch row count=${rowCount}, sessions: ${live ? `${live.id} live, command=${live.command}` : describeSessions(seen)}, argv=${argv === null ? "not recorded" : JSON.stringify(captured)}`,
    );
  },
);
