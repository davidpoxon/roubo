import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CURSOR_AGENT_NAME,
  CURSOR_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  disablePlugin,
  enablePlugin,
  readAgentConfig,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";
import {
  CURSOR_ARGV_LOG_PATH,
  clearCapturedCursorArgv,
  readCapturedCursorArgv,
} from "./_support/argv-log.js";
import { clearCursorBuild } from "./_support/cursor-version.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "APCC-TC-025".
const observe = makeObserve("APCC-TC-025");

// APCC-TC-025 - e2e: a user sets a mode and extra arguments, then launches.
//
// The integration-level drift guard for the APCC-US-003 journey (APCC-FR-011,
// APCC-FR-012), spanning the slices this unit is blocked by (see SLICE).
// It walks the authoritative APCC-TC-025 e2e_flow steps S001-S005 as ordered,
// attributable observations against the REAL built app. On divergence each
// observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice(s).
//
// HOW THE CURSOR CLI PLUGIN PRECONDITION IS MET. The shipping plugin lives in the
// sibling `roubo-plugins` repo and builds against the published SDK, so roubo's
// e2e suite cannot depend on it. Instead an agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/cursor-cli/ takes the `cursor-cli` id, as the
// claude-code and codex-cli overlays take theirs. Its `configSchema` is copied
// verbatim from the real manifest, so the AI Agents card renders the real Model,
// Mode and Additional CLI arguments fields, and its `translateLaunch` mirrors the
// real `buildArgs` + `tokenize` ordering. This journey selects no permission
// posture, so the host appends no posture flags after the generated ones.
//
// PARTIAL CIRCULARITY, stated plainly: because the overlay implements the argv
// mapping, this guard cannot prove the real plugin's `buildArgs`. That mapping is
// unit-covered in roubo-plugins. What this guard proves is the HOST-side
// integrated path: the AI Agents form persisting app-level Cursor defaults, the
// launch resolving them through the four-layer config, the pre-launch version
// gate passing, and the values reaching the spawned CLI as separate argv tokens.
//
// THE ASSEMBLED COMMAND IS THE CAPTURED ARGV. S004 says "read the assembled
// command" and S005 says the session starts "with the command the plugin
// assembled for the saved configuration", and Roubo has no command-preview
// surface: no UI and no API reports an agent session's argv before or after
// launch. The AP-TC-087 and AP-TC-105 guards met the same wording the same way,
// and so does this one: the assembled command is the argv the spawned child
// actually received. The overlay names a stub binary
// (e2e/fixtures/bin/roubo-e2e-cursor-stub, deliberately NOT called `agent` so a
// real install cannot win the PATH lookup) which writes its OWN
// `process.argv.slice(2)` as JSON to CURSOR_ARGV_LOG_PATH. Reconstructing the
// argv host-side would assert our own arithmetic rather than the child's reality.
//
// THE LAUNCH THEREFORE PRECEDES THE S004 OBSERVATIONS. The command only exists
// once it is spawned, so the test performs the S005 launch first, then reports
// S004's observations over the captured argv, then S005's own. Every observation
// still carries its own step id, so a divergence names the step the case assigns
// it to.

const PLUGIN_ID = CURSOR_PLUGIN_ID;
const AGENT_NAME = CURSOR_AGENT_NAME;
const PROJECT_ID = "apcc-tc-025-cursor-launch";
const BENCH_ID = 1;

const ALL_AGENTS_SECTION = "All agents";

/** The command the `cursor-cli` overlay's launch descriptor names. */
const CURSOR_COMMAND = "roubo-e2e-cursor-stub";

/** The mode S002 selects, and the option label its `oneOf` title renders. */
const MODE = "plan";
const MODE_LABEL = "Plan";

/**
 * The extra argument S003 enters. Two tokens, so S004 can see that the host
 * split it into separate argv entries rather than passing one joined string.
 */
const EXTRA_ARGS = "--output-format text";
const EXTRA_ARGV = ["--output-format", "text"];

/** The generated flags the overlay assembles from mode=plan with no model set. */
const GENERATED_ARGV = ["--mode", MODE];

/**
 * The whole argv the launch must spawn: generated flags first, extra tokens
 * after. Auto-injection is off for this spec, so no jig positional trails it.
 */
const EXPECTED_ARGV = [...GENERATED_ARGV, ...EXTRA_ARGV];

// The slices this unit is blocked by, used by the FR-020 failure-output contract
// to attribute a divergence to an owning slice. Their issues live in a tracker
// this repository does not link to, so each is named by a short descriptive
// label of what it delivers, not by its issue number or issue title. The labels
// match cursor-model-config-journey.spec.ts, which names the same slices. The
// blocked-by set is a conservative superset of the slices the journey traverses.
const SLICE = {
  spike: { title: "Cursor parameterized model form investigation" },
  model: { title: "Cursor model field populated from the probe" },
  modeAndArgs: { title: "Cursor session axes and worktree guard" },
} as const;

// Instructions copied verbatim from the APCC-TC-025 e2e_flow.
const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the Cursor configuration.",
    owners: [SLICE.model, SLICE.modeAndArgs],
  },
  S002: {
    id: "S002",
    instruction: "Set the mode to plan.",
    owners: [SLICE.modeAndArgs],
  },
  S003: {
    id: "S003",
    instruction: "Enter an additional CLI argument.",
    owners: [SLICE.modeAndArgs],
  },
  S004: {
    id: "S004",
    instruction: "Read the assembled command.",
    owners: [SLICE.modeAndArgs, SLICE.spike],
  },
  S005: {
    id: "S005",
    instruction: "Launch a session from a bench.",
    owners: [SLICE.modeAndArgs, SLICE.model, SLICE.spike],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  command?: string;
  agentPluginId?: string;
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
 * one under test and leave an idling stub behind (NFR-018).
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/** Poll until a live Cursor session exists, or give up after 15s. */
async function waitForLiveCursorSession(
  request: APIRequestContext,
): Promise<{ live?: TerminalSessionEntry; seen: TerminalSessionEntry[] }> {
  let seen: TerminalSessionEntry[] = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    seen = await listSessions(request);
    const live = seen.find(
      (session) => session.agentPluginId === PLUGIN_ID && session.status === "live",
    );
    if (live !== undefined) return { live, seen };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { seen };
}

/** Poll until the spawned child has written its argv, or give up after 15s. */
async function waitForCapturedCursorArgv(): Promise<string[] | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const argv = readCapturedCursorArgv();
    if (argv !== null) return argv;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function describeSessions(sessions: TerminalSessionEntry[]): string {
  return sessions.length === 0
    ? "no terminal session was created"
    : sessions
        .map(
          (session) =>
            `${session.id}: status=${session.status}, agent=${session.agentPluginId}, command=${session.command}`,
        )
        .join("; ");
}

/** The index of `first` immediately followed by `second` in `argv`, or -1. */
function adjacentPairIndex(argv: string[], first: string, second: string): number {
  return argv.findIndex((token, index) => token === first && argv[index + 1] === second);
}

/** The index at which `tokens` appear in `argv` as one contiguous run, or -1. */
function runIndex(argv: string[], tokens: string[]): number {
  for (let start = 0; start + tokens.length <= argv.length; start += 1) {
    if (tokens.every((token, offset) => argv[start + offset] === token)) return start;
  }
  return -1;
}

/**
 * Set the app-level jig behaviour, preserving the pinned default agent. Called
 * BEFORE {@link setDefaultAgent}, whose own payload preserves whatever it reads
 * back, so the two writes compose rather than clobber.
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

/** Open the AI Agents settings screen and answer the Cursor card. */
async function openCursorCard(page: Page): Promise<Locator> {
  const res = await page.goto("/settings#ai-agents");
  expect(res?.status(), "GET /settings").toBe(200);
  return findCursorCard(page);
}

/**
 * Reload the settings screen and answer the Cursor card again. A reload, not a
 * second `goto`: the URL is unchanged, so `goto` would be a same-document hash
 * navigation that re-fetches nothing, and the form must be rebuilt from what the
 * server hands back for the read to be evidence of persistence.
 */
async function reloadCursorCard(page: Page): Promise<Locator> {
  const res = await page.reload();
  expect(res?.status(), "reload /settings").toBe(200);
  return findCursorCard(page);
}

async function findCursorCard(page: Page): Promise<Locator> {
  const agentsTab = page.getByRole("tab", { name: "AI Agents" });
  await expect(agentsTab, "the AI Agents settings tab renders").toBeVisible();
  await agentsTab.click();
  const card = page
    .getByRole("region", { name: "Installed agent plugins" })
    .getByTestId(`agent-plugin-card-${PLUGIN_ID}`);
  // A TOLERATED wait, not an assertion: a card that never renders leaves the
  // field reads below empty, which the calling observation reports as an
  // attributed divergence rather than as an unattributed Playwright timeout.
  await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  return card;
}

/**
 * Save the card's draft and wait for the round trip. The "Saved." indicator is
 * how long to wait, not the observation: each step reads the persisted record
 * back, so a save that silently failed is reported there.
 */
async function saveDefaults(page: Page): Promise<void> {
  const save = page.getByTestId(`agent-config-save-${PLUGIN_ID}`);
  await save.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (!(await save.isEnabled().catch(() => false))) return;
  await save.click();
  await page
    .getByTestId(`agent-config-form-${PLUGIN_ID}`)
    .getByText("Saved.")
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
}

/** Open the bench's Terminal tab. */
async function openTerminalTab(page: Page): Promise<void> {
  const res = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(res?.status(), "GET the bench detail page").toBe(200);
  const tab = page.getByRole("tab", { name: "Terminal" });
  await expect(tab, "the bench detail view has a Terminal tab").toBeVisible();
  await tab.click();
}

/**
 * Launch Cursor from the split button's "All agents" section. Every wait is
 * TOLERATED: a menu or row that never appears leaves S005-O01 to report the
 * missing session through the FR-020 block.
 */
async function launchCursorFromAllAgents(page: Page): Promise<void> {
  // With no sessions open the tab bar and the empty state each render one
  // chevron; the first is the one in the tab bar.
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  const menu = page.getByRole("menu");
  // The menu's sections render before the agent inventory resolves, so wait on
  // a row rather than on the menu alone.
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  // Every row carries the same `launch-agent-item` test id, so the row is
  // identified by its accessible name, `<agent name>: <effective params>`.
  const row = page
    .getByRole("group", { name: ALL_AGENTS_SECTION })
    .getByRole("menuitem", { name: new RegExp(`^${AGENT_NAME}:`) });
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await row.count()) === 0) return;
  const pending = page
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" && res.url().includes(`/benches/${BENCH_ID}/terminals`),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await row.click();
  await pending;
}

test.beforeEach(async ({ request }) => {
  test.setTimeout(90_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: the Cursor CLI plugin is installed, enabled and consented. The
  // overlay is force-disabled by every /test/__reset
  // (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS), so it is enabled here and handed back
  // disabled in afterEach. `resolveAgent` refuses an unconsented agent, so
  // without consent the card would read unavailable and the launch would 403.
  await enablePlugin(request, PLUGIN_ID);
  await consentAgent(request, PLUGIN_ID);
  await waitForAvailableAgents(request, [PLUGIN_ID]);

  // App-level agent defaults are NOT among the files /test/__reset truncates, so
  // a previous run's saved mode and extra arguments would leave S002 and S003
  // already at their targets (NFR-018).
  await clearAgentConfig(request, PLUGIN_ID);

  // No jig on the launch: an injected jig arrives as a trailing argv positional,
  // which would sit after the extra tokens and blur what S004-O02 reads.
  await setJigSettings(request, { autoInject: false, autoExecute: true });
  // Pinned explicitly rather than left to the lone-available-agent fallback,
  // which a second enabled agent removes.
  await setDefaultAgent(request, PLUGIN_ID);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 25,
            integrationId: "github-com",
            externalId: "25",
            title: "Set a Cursor mode and extra arguments, then launch",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  clearCapturedCursorArgv();
  // The stub reports the build a mode file names, and the APCC-TC-052 journey
  // writes a below-the-floor build into it. Cleared here so an interrupted run
  // of that spec cannot leave this launch blocked by the version gate.
  clearCursorBuild();
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  await clearAgentConfig(request, PLUGIN_ID);
  await setJigSettings(request, { autoInject: true, autoExecute: true });
  await setDefaultAgent(request, null);
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, PLUGIN_ID);
  clearCapturedCursorArgv();
});

test(
  "APCC-TC-025: set the Cursor mode and an extra argument, then launch with that command (S001-S005)",
  { tag: "@APCC-TC-025" },
  async ({ page, request }) => {
    // --- S001: open the Cursor configuration -----------------------------------
    let card = await openCursorCard(page);
    // Scoped to the Cursor card: the ambient claude-code overlay renders its own
    // `mode` and `extraArgs` fields on the same screen. Read once, so the boolean
    // and the reported actual cannot disagree.
    const fieldCounts = {
      model: await card.getByTestId("config-field-model").count(),
      mode: await card.getByTestId("config-field-mode").count(),
      extraArgs: await card.getByTestId("config-field-extraArgs").count(),
    };
    observe(
      STEPS.S001,
      "S001-O01",
      Object.values(fieldCounts).every((count) => count === 1),
      "The session fields render: the Cursor card shows one Model, one Mode and one Additional CLI arguments field",
      `model=${fieldCounts.model}, mode=${fieldCounts.mode}, extraArgs=${fieldCounts.extraArgs}`,
    );

    // --- S002: set the mode to plan --------------------------------------------
    // React Aria's Select renders the trigger as a Button inside the testid'd root
    // and portals its ListBox to the document body, so the option is located at
    // page level rather than within the field.
    await card
      .getByTestId("config-field-mode")
      .locator("button")
      .click({ timeout: 15_000 })
      .catch(() => {});
    await page
      .getByRole("option", { name: MODE_LABEL, exact: true })
      .click({ timeout: 15_000 })
      .catch(() => {});
    await saveDefaults(page);

    // Persistence is read twice: from the saved record through the real route,
    // and from the form after a reload, which can only show what the server
    // hands back. The form is read from React Aria's hidden native <select>, whose
    // value is the selection itself: the field's text content also carries every
    // option label (Agent, Plan, Ask), so matching on it would pass whatever was
    // selected.
    const afterMode = await readAgentConfig(request, PLUGIN_ID);
    card = await reloadCursorCard(page);
    const modeSelected = await card
      .getByTestId("config-field-mode")
      .locator('[data-testid="hidden-select-container"] select')
      .inputValue({ timeout: 15_000 })
      .catch(() => "");
    observe(
      STEPS.S002,
      "S002-O01",
      afterMode.mode === MODE && modeSelected === MODE,
      `The mode persists: the saved config has mode=${MODE} and the reloaded form has ${MODE_LABEL} selected`,
      `saved mode=${JSON.stringify(afterMode.mode)}, reloaded form selection=${JSON.stringify(modeSelected)}`,
    );

    // --- S003: enter an additional CLI argument ---------------------------------
    await card
      .getByTestId("config-field-extraArgs")
      .locator("input")
      .fill(EXTRA_ARGS, { timeout: 15_000 })
      .catch(() => {});
    await saveDefaults(page);

    const afterArgs = await readAgentConfig(request, PLUGIN_ID);
    card = await reloadCursorCard(page);
    const argsShown = await card
      .getByTestId("config-field-extraArgs")
      .locator("input")
      .inputValue({ timeout: 15_000 })
      .catch(() => "");
    observe(
      STEPS.S003,
      "S003-O01",
      afterArgs.extraArgs === EXTRA_ARGS && argsShown === EXTRA_ARGS && afterArgs.mode === MODE,
      `The argument persists: the saved config has extraArgs=${JSON.stringify(EXTRA_ARGS)} (with mode=${MODE} kept) and the reloaded form shows it`,
      `saved config=${JSON.stringify(afterArgs)}, reloaded field value=${JSON.stringify(argsShown)}`,
    );

    // --- S005 action: launch a session from a bench ------------------------------
    // Performed before the S004 observations: the assembled command is the argv
    // the spawned child received, and it only exists once the child runs (see the
    // header).
    await openTerminalTab(page);
    // Unlink first so the argv read below can only be this launch's.
    clearCapturedCursorArgv();
    await launchCursorFromAllAgents(page);
    const { live, seen } = await waitForLiveCursorSession(request);
    const argv = await waitForCapturedCursorArgv();
    const captured = argv ?? [];
    const shown =
      argv === null
        ? `no argv was captured at ${CURSOR_ARGV_LOG_PATH}: the child never ran`
        : JSON.stringify(argv);

    // --- S004: read the assembled command ----------------------------------------
    // Each observation also requires that no token carries whitespace: a shell
    // between the host and the child would have re-split or de-quoted them, so
    // their survival as written is evidence of an argv-array spawn.
    const modeIndex = adjacentPairIndex(captured, "--mode", MODE);
    observe(
      STEPS.S004,
      "S004-O01",
      modeIndex !== -1 && captured.every((token) => !/\s/.test(token)),
      `The command carries the mode flag and its value as separate entries: "--mode" immediately followed by "${MODE}", never "--mode=${MODE}" or "--mode ${MODE}"`,
      shown,
    );

    const extraIndex = runIndex(captured, EXTRA_ARGV);
    observe(
      STEPS.S004,
      "S004-O02",
      modeIndex !== -1 &&
        extraIndex >= modeIndex + GENERATED_ARGV.length &&
        JSON.stringify(captured) === JSON.stringify(EXPECTED_ARGV),
      `The extra argument appears after the generated flags: exactly ${JSON.stringify(EXPECTED_ARGV)}`,
      shown,
    );

    // --- S005: the session starts with the assembled command ---------------------
    observe(
      STEPS.S005,
      "S005-O01",
      live !== undefined &&
        live.command === CURSOR_COMMAND &&
        JSON.stringify(captured) === JSON.stringify(EXPECTED_ARGV),
      `The session starts with the command the plugin assembled for the saved configuration: a live ${AGENT_NAME} session (agentPluginId=${PLUGIN_ID}, command=${CURSOR_COMMAND}) whose child received ${JSON.stringify(EXPECTED_ARGV)}`,
      `${live === undefined ? describeSessions(seen) : `${live.id}: status=${live.status}, agent=${live.agentPluginId}, command=${live.command}`}; argv=${shown}`,
    );
  },
);
