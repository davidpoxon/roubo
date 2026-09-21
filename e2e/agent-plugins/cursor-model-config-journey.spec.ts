import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedCursorArgv, readCapturedCursorArgv } from "./_support/argv-log.js";
import {
  CURSOR_AGENT_NAME,
  CURSOR_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  disablePlugin,
  enablePlugin,
  readAgentConfig,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "APCC-TC-011".
const observe = makeObserve("APCC-TC-011");

// APCC-TC-011: a user configures a Cursor model.
//
// The integration-level drift guard for the APCC-FR-009 / APCC-US-002 /
// APCC-US-003 journey. It walks the authoritative APCC-TC-011 e2e_flow steps
// S001-S004 as ordered, attributable observations against the REAL built app:
// the host probe runner and its `dash-line-pairs` parser reading the model
// listing, the probed choices on the AI Agents form, the app-level config save,
// and a real launch from the bench Terminal tab. On divergence each observation
// routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice(s).
//
// HOW THE CURSOR PLUGIN PRECONDITION IS MET. The shipping plugin lives in the
// sibling `roubo-plugins` repo and builds against the published SDK, so roubo's
// e2e suite cannot depend on it. Instead the agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/cursor-cli/ takes the `cursor-cli` id. Its
// configSchema and `model` choice probe are copied from the real manifest, and
// its `translateLaunch` mirrors the real `buildArgs`. Every command it names is
// `roubo-e2e-cursor-stub` (e2e/fixtures/bin/), which answers `--list-models`
// with an excerpt of a recorded real `agent --list-models` listing. The overlay
// is force-DISABLED by every /test/__reset (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in
// server/routes/test.ts), so this spec opts it in and hands it back disabled.
//
// PARTIAL CIRCULARITY, stated plainly: because the overlay implements the argv
// mapping, S004 cannot prove the shipped plugin's `buildArgs`. That mapping is
// unit-covered in roubo-plugins (translate-launch.test.ts, APCC-TC-011). What
// this guard proves is the HOST-side integrated path: the probe filling the
// field, the form persisting the selected id rather than its label, and that id
// reaching the spawned CLI unchanged through a real launch.
//
// S004 READS THE LAUNCHED ARGV, NOT A SCREEN PREVIEW. The case says "Read the
// assembled command the screen previews", but the AI Agents screen has no
// command preview: the "Assembled command" card exists only in the spec's
// prototype, and no slice builds one yet. The assembled command is therefore
// read the way AP-TC-087 and AP-TC-105 read theirs: the stub writes its own
// `process.argv.slice(2)` as JSON to CURSOR_ARGV_LOG_PATH, and S004's
// observations are asserted over that array. Its three observations are about
// the command, not about the preview widget, so they carry over unchanged.
//
// NOT COVERED: whether the Cursor server really runs a session on the requested
// model. That needs a paid Cursor account, since the Free plan refuses every
// named model, and a stubbed CLI cannot answer it; it stays a manual check.

const PROJECT_ID = "apcc-tc-011-cursor-model";
const BENCH_ID = 1;
const SETTINGS_PATH = "/settings#ai-agents";
const FIELD = "model";
const ALL_AGENTS_SECTION = "All agents";

/** The command the `cursor-cli` overlay's launch descriptor names. */
const CURSOR_COMMAND = "roubo-e2e-cursor-stub";

/** The upper bound on one probe run, with room for the spawn itself. */
const PROBE_SETTLE_TIMEOUT_MS = 10_000;

/** The pairs `roubo-e2e-cursor-stub --list-models` prints, in listing order. */
const LISTED_MODELS = [
  { value: "auto", label: "Auto (current, default)" },
  { value: "gpt-5.3-codex-high", label: "Codex 5.3 High" },
  { value: "gpt-5.3-codex-high-fast", label: "Codex 5.3 High Fast" },
  { value: "composer-2.5", label: "Composer 2.5" },
  { value: "claude-opus-5-thinking-high-fast", label: "Claude Opus 5 1M Thinking Fast" },
] as const;

/**
 * The `-high-fast` id S003 selects: an id that carries an effort (`high`) and a
 * speed (`fast`), and not the first listed, so a default cannot pass for a pick.
 */
const PICK = LISTED_MODELS[2];

// The slices this unit is blocked by, used by the FR-020 failure-output contract
// to attribute a divergence to an owning slice. Their issues live in a tracker
// this repository does not link to, so each is named by a short descriptive
// label of what it delivers, not by its issue number or issue title. The
// journey-to-slice mapping is by requirement and story overlap, so each step
// names a conservative superset.
const SLICE = {
  paramForm: { title: "Cursor parameterized model form investigation" },
  listing: { title: "Cursor model listing parse contract" },
  runner: { title: "Host probe runner and parse-mode registry" },
  states: { title: "Probe states on the AI Agents settings screen" },
  modelField: { title: "Cursor model field populated from the probe" },
  axes: { title: "Cursor session axes and worktree guard" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the AI Agents settings screen for the Cursor plugin.",
    owners: [SLICE.states, SLICE.modelField],
  },
  S002: {
    id: "S002",
    instruction: "Wait for the model field to resolve.",
    owners: [SLICE.listing, SLICE.runner, SLICE.states, SLICE.modelField],
  },
  S003: {
    id: "S003",
    instruction:
      "Select a listed model id that carries an effort and a speed, such as a `-high-fast` id.",
    owners: [SLICE.modelField],
  },
  S004: {
    id: "S004",
    instruction: "Read the assembled command the screen previews.",
    owners: [SLICE.paramForm, SLICE.modelField, SLICE.axes],
  },
};

type ProbeState = "loading" | "resolved" | "failed";

interface AgentSnapshot {
  id: string;
  unavailable: { reason: string } | null;
  choiceProbes?: Record<string, { state: ProbeState }>;
}

interface TerminalSessionEntry {
  id: string;
  status: string;
  command?: string;
  agentPluginId?: string;
}

/** The overlay as the real agent inventory route reports it, if it is listed. */
async function readAgent(request: APIRequestContext): Promise<AgentSnapshot | undefined> {
  const res = await request.get("/api/agents");
  if (res.status() !== 200) return undefined;
  const body = (await res.json()) as { agents: AgentSnapshot[] };
  return body.agents.find((a) => a.id === CURSOR_PLUGIN_ID);
}

/** The model field's probe state, or `undefined` while the agent is not available. */
async function readProbeState(request: APIRequestContext): Promise<ProbeState | undefined> {
  const agent = await readAgent(request);
  if (!agent || agent.unavailable !== null) return undefined;
  return agent.choiceProbes?.[FIELD]?.state;
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
 * cleared by `/test/__reset`, so a session from an earlier run would leave an
 * idling stub behind (NFR-018).
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
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

/**
 * Set the app-level jig behaviour. Auto-injection is switched off for the
 * launch, so no jig arrives as a trailing argv positional: S004 is about the
 * generated command, and a stray positional would only have to be explained
 * away.
 */
async function setJigAutoInject(request: APIRequestContext, autoInject: boolean): Promise<void> {
  const current = (await (await request.get("/api/settings")).json()) as {
    theme?: string;
    jigs?: { defaultAgentPluginId?: string; defaultJigId?: string };
  };
  const res = await request.put("/api/settings", {
    data: {
      theme: current.theme ?? "dark",
      jigs: {
        autoInject,
        autoExecute: true,
        ...(current.jigs?.defaultAgentPluginId != null && {
          defaultAgentPluginId: current.jigs.defaultAgentPluginId,
        }),
        ...(current.jigs?.defaultJigId != null && { defaultJigId: current.jigs.defaultJigId }),
      },
    },
  });
  expect(res.status(), "PUT /api/settings (jig settings)").toBe(200);
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
 * The "All agents" row for one agent, identified by its accessible name, which
 * AgentItem builds as `<agent name>: <effective params or blocker>`.
 */
function allAgentsRow(page: Page, agentName: string): Locator {
  return page
    .getByRole("group", { name: ALL_AGENTS_SECTION })
    .getByRole("menuitem", { name: new RegExp(`^${agentName}:`) });
}

/**
 * Launch Cursor from the "All agents" section of the split button's launch menu.
 * Every wait is TOLERATED: a menu or row that never appears leaves S004 to
 * report the divergence through the FR-020 block rather than failing here as an
 * unattributed Playwright timeout.
 */
async function launchCursorFromAllAgents(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // The menu renders its sections before the agent inventory resolves, so wait
  // for a row rather than for the menu alone.
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  const row = allAgentsRow(page, CURSOR_AGENT_NAME);
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await row.count()) === 0) return;
  await row.click();
}

test.beforeEach(async ({ request }) => {
  // A probe, a save, a reload and a real launch do not fit the config's 30s
  // per-test default.
  test.setTimeout(120_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: the Cursor plugin is installed. The overlay is force-disabled
  // by every reset, so it is enabled here, and consented, because `resolveAgent`
  // refuses an unconsented agent.
  await enablePlugin(request, CURSOR_PLUGIN_ID);
  await consentAgent(request, CURSOR_PLUGIN_ID);
  await waitForAvailableAgents(request, [CURSOR_PLUGIN_ID]);

  // App-level agent defaults outlive /test/__reset. A saved model would
  // pre-select the pick and make S003's save a no-op, so start every run from an
  // empty record (NFR-018).
  await clearAgentConfig(request, CURSOR_PLUGIN_ID);
  await setJigAutoInject(request, false);
  clearCapturedCursorArgv();

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 11,
            integrationId: "github-com",
            externalId: "11",
            title: "A user configures a Cursor model",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // A probe run still in flight would write its outcome into the probe cache
  // AFTER the next reset cleared it, and hand the next test this test's state.
  await expect
    .poll(() => readProbeState(request), { timeout: PROBE_SETTLE_TIMEOUT_MS })
    .not.toBe("loading");
  await clearAgentConfig(request, CURSOR_PLUGIN_ID);
  await setJigAutoInject(request, true);
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, CURSOR_PLUGIN_ID);
  clearCapturedCursorArgv();
});

test(
  "APCC-TC-011: a user configures a Cursor model (S001-S004)",
  { tag: "@APCC-TC-011" },
  async ({ page, request }) => {
    // --- S001: the AI Agents screen renders the Cursor configuration --------
    const settingsRes = await page.goto(SETTINGS_PATH);
    expect(settingsRes?.status(), `GET ${SETTINGS_PATH}`).toBe(200);
    // Every read is scoped to the Cursor card: `config-field-model` is unique
    // only WITHIN a card, and the claude-code overlay renders one too.
    const card = page.getByTestId(`agent-plugin-card-${CURSOR_PLUGIN_ID}`);
    const form = card.getByTestId(`agent-config-form-${CURSOR_PLUGIN_ID}`);
    const field = card.getByTestId(`config-field-${FIELD}`);
    await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const cardCount = await card.count();
    const fieldCount = await field.count();
    observe(
      STEPS.S001,
      "S001-O01",
      cardCount === 1 && (await form.count()) === 1 && fieldCount === 1,
      `the AI Agents screen renders the ${CURSOR_PLUGIN_ID} card with its configuration form and a Model field`,
      `card count=${cardCount}, form count=${await form.count()}, model field count=${fieldCount}`,
    );

    // --- S002: the model field resolves to the account's models -------------
    // Tolerated wait for the field to leave `loading`; S002-O01 reports a probe
    // that never resolves with its expected-vs-actual.
    await expect(field)
      .not.toHaveAttribute("data-probe-state", { timeout: PROBE_SETTLE_TIMEOUT_MS })
      .catch(() => {});
    const settledState = await field.getAttribute("data-probe-state").catch(() => null);
    const apiState = await readProbeState(request);

    // React Aria's Select portals its ListBox to the document body, so the
    // options are read at page level once the trigger opens it.
    let optionTexts: string[] = [];
    if (settledState === null) {
      await field.locator("button").click();
      const options = page.getByRole("listbox").getByRole("option");
      await options
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => {});
      optionTexts = (await options.allTextContents()).map((text) => text.trim());
    }
    const expectedLabels = LISTED_MODELS.map((model) => model.label);
    observe(
      STEPS.S002,
      "S002-O01",
      apiState === "resolved" && JSON.stringify(optionTexts) === JSON.stringify(expectedLabels),
      `the probe resolves and the field lists the ${LISTED_MODELS.length} listed models: ${expectedLabels.join(", ")}`,
      settledState === null
        ? `probe state=${apiState ?? "unavailable"}, options=${JSON.stringify(optionTexts)}`
        : `the field never resolved: data-probe-state=${settledState}, probe state=${apiState ?? "unavailable"}`,
    );

    // --- S003: select a `-high-fast` id; the selection persists --------------
    await page
      .getByRole("option", { name: PICK.label, exact: true })
      .click({ timeout: 5_000 })
      .catch(() => {});
    const save = page.getByTestId(`agent-config-save-${CURSOR_PLUGIN_ID}`);
    await save.click({ timeout: 5_000 }).catch(() => {});
    // Tolerated wait: "Saved." is how long to wait for the round trip. The
    // observation below reads the persisted record back through the real API.
    await form
      .getByText("Saved.")
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    // Persistence means across a reload of the screen, not only in the form's
    // own optimistic state, and the stored value is the id, not its label.
    await page.reload();
    await field.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    await expect(field)
      .not.toHaveAttribute("data-probe-state", { timeout: PROBE_SETTLE_TIMEOUT_MS })
      .catch(() => {});
    const reloadedText = (
      (await field
        .locator("button")
        .textContent()
        .catch(() => null)) ?? ""
    ).trim();
    const persisted = await readAgentConfig(request, CURSOR_PLUGIN_ID);
    observe(
      STEPS.S003,
      "S003-O01",
      persisted[FIELD] === PICK.value && reloadedText === PICK.label,
      `after a reload the field still shows "${PICK.label}" and the saved ${FIELD} is the id "${PICK.value}"`,
      `field shows ${JSON.stringify(reloadedText)}, persisted config=${JSON.stringify(persisted)}`,
    );

    // --- S004: the assembled command (see the header on the preview) ---------
    await openTerminalTab(page);
    clearCapturedCursorArgv();
    await launchCursorFromAllAgents(page);
    const argv = await waitForCapturedCursorArgv();
    const sessions = await listSessions(request);
    const launched = sessions.find((session) => session.agentPluginId === CURSOR_PLUGIN_ID);
    const launchedDescription =
      argv === null
        ? `no argv was captured; sessions=${JSON.stringify(sessions)}`
        : `argv=${JSON.stringify(argv)}, session command=${launched?.command ?? "none"}`;

    const modelFlagIndexes = (argv ?? []).flatMap((token, index) =>
      token === "--model" || token.startsWith("--model=") ? [index] : [],
    );
    observe(
      STEPS.S004,
      "S004-O01",
      argv !== null && launched?.command === CURSOR_COMMAND && modelFlagIndexes.length === 1,
      `the launched ${CURSOR_COMMAND} command carries exactly one --model flag`,
      argv === null
        ? launchedDescription
        : `${modelFlagIndexes.length} model flag(s); ${launchedDescription}`,
    );

    // The value of the one model flag: the next argv entry for `--model <id>`,
    // or the text after `=` for the joined `--model=<id>` form, so either shape
    // reports its real value below.
    const modelToken =
      argv !== null && modelFlagIndexes.length === 1 ? argv[modelFlagIndexes[0]] : undefined;
    const joined = modelToken?.startsWith("--model=") ?? false;
    const modelValue =
      modelToken === undefined
        ? undefined
        : joined
          ? modelToken.slice("--model=".length)
          : argv?.[modelFlagIndexes[0] + 1];

    // O02 and O03 split "exactly the selected id" into two attributable halves.
    // O02 is the id itself: not reduced to a base name, not swapped for another
    // listed id, and its own argv entry. O03 is the absence of a bracketed
    // parameter suffix. O02 compares the value with every such suffix removed, so a
    // bracketed value reaches O03 and is reported there, not as an O02 mismatch.
    const bracketSuffix = /(\[[^\]]*\])+$/;
    const modelId = modelValue?.replace(bracketSuffix, "");
    observe(
      STEPS.S004,
      "S004-O02",
      !joined && modelId === PICK.value,
      `the --model value is the selected id "${PICK.value}", unchanged and as its own argv entry`,
      `--model value=${JSON.stringify(modelValue ?? null)}${joined ? " (joined to the flag as one entry)" : ""}; ${launchedDescription}`,
    );

    observe(
      STEPS.S004,
      "S004-O03",
      modelValue !== undefined && !/[[\]]/.test(modelValue),
      "the --model value carries no bracketed parameters",
      `--model value=${JSON.stringify(modelValue ?? null)}`,
    );
  },
);
