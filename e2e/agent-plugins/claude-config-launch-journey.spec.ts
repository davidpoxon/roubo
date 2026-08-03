import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { AGENT_ARGV_LOG_PATH, clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-087".
const observe = makeObserve("AP-TC-087");

// AP-TC-087 (#531, AP-WU-030) - E2E: configure the Claude Code model, effort,
// mode and extra args, then launch and verify the assembled CLI invocation.
//
// The integration-level drift guard for the AP-US-008 journey (AP-FR-017),
// spanning the slices this unit is blocked by (#511, #536). It walks the
// authoritative AP-TC-087 e2e_flow steps S001-S008 as ordered, attributable
// observations against the REAL built app. On divergence each observation routes
// through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s).
//
// HOW THE CLAUDE CODE PLUGIN PRECONDITION IS MET. The shipping plugin lives in
// the sibling `roubo-plugins` repo and builds against the published SDK, so
// roubo's e2e suite cannot depend on it. Instead an agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/claude-code/ takes the `claude-code` id, exactly
// as the `github-com` / `ghe` overlays take theirs. Its `configSchema` is copied
// verbatim from the real manifest, so the AI Agents card renders the real Model /
// Effort / Mode selects and the real Additional CLI arguments field, and its
// `translateLaunch` mirrors the real `buildArgs` + `tokenize` ordering.
//
// PARTIAL CIRCULARITY, stated plainly: because the overlay implements the argv
// mapping, this guard cannot prove the real plugin's `buildArgs`. That mapping is
// unit-covered in roubo-plugins. What this guard proves is the HOST-side
// integrated path, which nothing else covers end to end: the AI Agents form
// persisting app-level defaults, the launch resolving them through the four-layer
// config, the pre-launch version gate passing, and the values reaching the
// spawned CLI as separate argv tokens.
//
// WHY THE ARGV IS READ FROM A FILE. S008 asks what the assembled launch command
// actually was. No API surfaces a session's argv, and reconstructing it host-side
// would assert our own arithmetic rather than the child's reality. The overlay's
// descriptor therefore names a stub binary (e2e/fixtures/bin/roubo-e2e-claude-stub,
// deliberately NOT called `claude` so a real install cannot win the PATH lookup)
// which writes its OWN `process.argv.slice(2)` as JSON to AGENT_ARGV_LOG_PATH,
// the one path both sides import. Asserting over that array is direct evidence for all
// three S008 observations, including "no shell interpretation": a shell would have
// re-split or expanded the tokens before the child ever saw them.

const PLUGIN_ID = "claude-code";
const AGENT_NAME = "Claude Code";
const PROJECT_ID = "ap-tc-087-claude-launch";
const BENCH_ID = 1;

// The overlay's manifest declares no permission category (empty network hosts,
// empty credential slots, empty filesystem paths, `processes: false`), so the
// consent gate is satisfied by an empty acknowledgement set.
const DECLARED_CATEGORIES: string[] = [];

// The configuration AP-TC-087 S003 + S004 ask for, and the argv prefix it must
// assemble into (S008-O01 + S008-O02).
const EXTRA_ARGS = "--fallback-model sonnet";
const EXPECTED_ARGV_PREFIX = [
  "--model",
  "opus",
  "--effort",
  "high",
  "--permission-mode",
  "plan",
  "--fallback-model",
  "sonnet",
];

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  plugin: { issue: 511, title: "Claude Code agent plugin: model, effort, mode, extra-args" },
  gate: { issue: 536, title: "Verify gate: Phase 1 Contract & Foundation" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open Settings and navigate to the AI Agents screen",
    owners: [SLICE.plugin],
  },
  S002: {
    id: "S002",
    instruction: "Click Configure on the Claude Code card",
    owners: [SLICE.plugin],
  },
  S003: {
    id: "S003",
    instruction: "Set Model=opus, Effort=high, Mode=plan",
    owners: [SLICE.plugin],
  },
  S004: {
    id: "S004",
    instruction: "Enter --fallback-model sonnet into the Additional CLI arguments field",
    owners: [SLICE.plugin],
  },
  S005: {
    id: "S005",
    instruction: "Click Save defaults",
    owners: [SLICE.plugin],
  },
  S006: {
    id: "S006",
    instruction: "Navigate to the bench Terminal tab",
    owners: [SLICE.plugin, SLICE.gate],
  },
  S007: {
    id: "S007",
    instruction: "Click the Agent launch button",
    owners: [SLICE.plugin, SLICE.gate],
  },
  S008: {
    id: "S008",
    instruction: "Inspect the assembled launch command for the new session",
    owners: [SLICE.plugin],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  agentPluginId?: string;
}

/**
 * Pick one closed-choice control on the schema-driven form by its option label.
 *
 * `card` scopes the field, and every `config-field-*` read below is scoped the
 * same way. The test ids are only unique WITHIN a card: `AgentPluginCard` mounts
 * each card's disclosure open, so every installed agent renders its own form at
 * once, and a page-wide read would count another agent's `model` control
 * alongside this one the moment a second schema-bearing agent is installed
 * (which the codex-cli overlay now is).
 */
async function selectChoice(
  page: Page,
  card: Locator,
  field: string,
  optionLabel: string,
): Promise<void> {
  // React Aria's Select renders the trigger as a Button inside the testid'd root
  // and portals its ListBox to the document body, so the option is located at
  // page level rather than within the field.
  await card.getByTestId(`config-field-${field}`).locator("button").click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

async function listSessions(request: APIRequestContext): Promise<TerminalSessionEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`);
  expect(res.status(), "GET terminals").toBe(200);
  // The route answers with a bare array of TerminalSession, not an envelope.
  const body = (await res.json()) as TerminalSessionEntry[];
  return Array.isArray(body) ? body : [];
}

/**
 * Drop every terminal session on this spec's bench.
 *
 * Live PTY sessions are held in a module-level map keyed by project + bench and
 * are NOT among the things `/test/__reset` clears, so a session opened by an
 * earlier run of this spec (against the same fixed project id and bench id)
 * would still be listed here. Clearing them at both ends of the test is what
 * keeps "a new session opened" observable rather than shadowed by a leftover
 * (NFR-018), and keeps the idling stub from outliving the run.
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "The Claude Code plugin is installed and enabled". The overlay
  // is discovered under ROUBO_BUNDLED_PLUGINS_DIR and `isPluginEnabled` defaults a
  // missing entry to enabled, so nothing has to enable it. It does have to be
  // CONSENTED: `resolveAgent` refuses an unconsented agent before it ever hands
  // out a connection, so without this the card would read unavailable and the
  // launch would 403.
  const consent = await request.post(`/api/plugins/${PLUGIN_ID}/consent`, {
    data: { acknowledgedCategories: DECLARED_CATEGORIES },
  });
  expect(consent.status(), "POST /consent for the claude-code overlay").toBe(200);

  // App-level agent defaults live in `~/.roubo-dev/<checkout>/agents/_global/` and
  // are NOT among the files /test/__reset truncates, so a previous run's saved
  // Claude defaults would survive into this one and leave the form already dirty-
  // free at the target values. Clearing them through the real API is what makes
  // S003-S005 observe a genuine edit-and-save on every run (NFR-018).
  const clearDefaults = await request.put(`/api/agents/${PLUGIN_ID}/config`, {
    data: { config: {} },
  });
  expect(clearDefaults.status(), "PUT /api/agents/claude-code/config (clear defaults)").toBe(200);

  // Precondition: "A bench is active". A seeded bench carries a real tmpdir
  // workspace, which is all `isBenchOperable` asks of it, so the journey needs no
  // worktree provisioning and no bench start.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 531,
            integrationId: "github-com",
            externalId: "531",
            title: "Configure Claude model, effort, mode, and extra args then launch",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  clearCapturedArgv();
});

test("AP-TC-087: configure Claude defaults, launch, and verify the assembled argv (S001-S008)", async ({
  page,
  request,
}) => {
  // --- S001: the AI Agents screen lists the Claude Code card -----------------
  const settingsRes = await page.goto("/settings#ai-agents");
  expect(settingsRes?.status(), "GET /settings").toBe(200);
  const agentsTab = page.getByRole("tab", { name: "AI Agents" });
  await expect(agentsTab, "the AI Agents settings tab renders").toBeVisible();
  await agentsTab.click();

  const installed = page.getByRole("region", { name: "Installed agent plugins" });
  const card = installed.getByTestId(`agent-plugin-card-${PLUGIN_ID}`);
  const disclosure = page.getByTestId(`agent-configure-${PLUGIN_ID}`);
  // A TOLERATED wait, not an assertion. Every condition an observation covers has
  // to fail through `observe` so the FR-020 block names the diverged step, the
  // expected-vs-actual and the owning slice; a bare `expect(...).toBeVisible()`
  // here would pre-empt S001-O01 and fail with an unattributed Playwright
  // timeout instead. The counts are then read ONCE, so the boolean and the
  // reported actual can never disagree.
  await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const cardCount = await card.count();
  const disclosureCount = await disclosure.count();
  observe(
    STEPS.S001,
    "S001-O01",
    cardCount === 1 && disclosureCount === 1,
    `the ${AGENT_NAME} card is listed under Installed with a Configure action`,
    `card count=${cardCount}, configure action count=${disclosureCount}`,
  );

  // --- S002: Configure expands the schema-driven config form -----------------
  // The card mounts with its disclosure OPEN (the per-plugin config is the whole
  // point of the screen), so collapse it first and then press Configure. That way
  // the step really is "click Configure" and the observation really is the form
  // appearing, rather than a form that was already there.
  if ((await disclosure.textContent())?.includes("Hide")) {
    await disclosure.click();
    await expect(page.getByTestId(`agent-config-form-${PLUGIN_ID}`)).toBeHidden();
  }
  await expect(disclosure, "the collapsed disclosure offers Configure").toHaveText(/Configure/);
  await disclosure.click();

  const form = page.getByTestId(`agent-config-form-${PLUGIN_ID}`);
  // Tolerated wait again: a form that never expands leaves all four field counts
  // at 0, which S002-O01 below reports as an attributed divergence.
  await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const fieldCounts = {
    model: await card.getByTestId("config-field-model").count(),
    effort: await card.getByTestId("config-field-effort").count(),
    mode: await card.getByTestId("config-field-mode").count(),
    extraArgs: await card.getByTestId("config-field-extraArgs").count(),
  };
  observe(
    STEPS.S002,
    "S002-O01",
    Object.values(fieldCounts).every((count) => count === 1),
    "the config form expands showing Model, Effort and Mode selects plus an Additional CLI arguments field",
    `model=${fieldCounts.model}, effort=${fieldCounts.effort}, mode=${fieldCounts.mode}, extraArgs=${fieldCounts.extraArgs}`,
  );

  // --- S003: Model=opus, Effort=high, Mode=plan ------------------------------
  await selectChoice(page, card, "model", "Opus");
  await selectChoice(page, card, "effort", "High");
  await selectChoice(page, card, "mode", "Plan");
  await expect(card.getByTestId("config-field-model")).toContainText("Opus");
  await expect(card.getByTestId("config-field-effort")).toContainText("High");
  await expect(card.getByTestId("config-field-mode")).toContainText("Plan");

  // --- S004: the Additional CLI arguments field -----------------------------
  const extraArgsInput = card.getByTestId("config-field-extraArgs").locator("input");
  await extraArgsInput.fill(EXTRA_ARGS);
  await expect(extraArgsInput).toHaveValue(EXTRA_ARGS);

  // --- S005: Save defaults persists the application-level Claude defaults ----
  const save = page.getByTestId(`agent-config-save-${PLUGIN_ID}`);
  await expect(save, "Save defaults is enabled once the draft diverges").toBeEnabled();
  await save.click();
  // Tolerated wait: the "Saved." indicator is how long to wait for the round
  // trip, not the observation. S005-O01 below reads the persisted record back
  // through the real API, so a save that silently failed is reported there with
  // its expected-vs-actual rather than throwing here unattributed.
  await form
    .getByText("Saved.")
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  // Read the persisted app-level record back through the real API rather than
  // trusting the form's own optimistic state.
  const configRes = await request.get(`/api/agents/${PLUGIN_ID}/config`);
  expect(configRes.status(), "GET /api/agents/claude-code/config").toBe(200);
  const persisted = (await configRes.json()) as { config?: Record<string, unknown> };
  const expectedConfig = { model: "opus", effort: "high", mode: "plan", extraArgs: EXTRA_ARGS };
  observe(
    STEPS.S005,
    "S005-O01",
    JSON.stringify(persisted.config ?? {}) === JSON.stringify(expectedConfig),
    `application-level Claude defaults persisted as ${JSON.stringify(expectedConfig)}`,
    `persisted config=${JSON.stringify(persisted.config ?? {})}`,
  );

  // --- S006: the bench Terminal tab offers the Agent launch split button -----
  const benchRes = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(benchRes?.status(), "GET the bench detail page").toBe(200);
  const terminalTab = page.getByRole("tab", { name: "Terminal" });
  await expect(terminalTab, "the bench detail view has a Terminal tab").toBeVisible();
  await terminalTab.click();

  // The primary segment's accessible name IS the resolved default agent
  // ("Launch <agentName>"), so finding it by that name is what proves the button
  // targets Claude Code rather than merely existing.
  const launchButton = page.getByRole("button", { name: `Launch ${AGENT_NAME}` });
  // Tolerated wait, for the same reason as S001: a button that never appears, or
  // one whose accessible name names a different default agent, is the single most
  // likely S006 divergence and has to be reported with its owning slice. The
  // enabled read is guarded on the count so it cannot throw when nothing matched,
  // which would otherwise bypass the observer from inside its own argument list.
  await launchButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const launchCount = await launchButton.count();
  const launchEnabled = launchCount === 1 ? await launchButton.isEnabled() : false;
  observe(
    STEPS.S006,
    "S006-O01",
    launchCount === 1 && launchEnabled,
    `the Agent launch split button is present and targets the default agent (${AGENT_NAME})`,
    `count=${launchCount}, enabled=${launchEnabled}`,
  );

  // --- S007: pressing it opens a new Claude PTY session ----------------------
  // Unlink first so the argv read in S008 can only be this launch's.
  clearCapturedArgv();
  await launchButton.click();

  let sessions: TerminalSessionEntry[] = [];
  let live: TerminalSessionEntry | undefined;
  for (let attempt = 0; attempt < 40 && live === undefined; attempt += 1) {
    sessions = await listSessions(request);
    live = sessions.find(
      (session) => session.agentPluginId === PLUGIN_ID && session.status === "live",
    );
    if (live === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  observe(
    STEPS.S007,
    "S007-O01",
    live !== undefined,
    `a new ${AGENT_NAME} PTY session opens (status=live, agentPluginId=${PLUGIN_ID})`,
    sessions.length === 0
      ? "no terminal session was created"
      : sessions
          .map(
            (session) => `${session.id}: status=${session.status}, agent=${session.agentPluginId}`,
          )
          .join("; "),
  );

  // --- S008: the argv the spawned CLI actually received ----------------------
  let argv: string[] | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    argv = readCapturedArgv();
    if (argv !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  observe(
    STEPS.S008,
    "S008-O01",
    argv !== null,
    `the spawned agent CLI recorded its argv at ${AGENT_ARGV_LOG_PATH}`,
    argv === null ? "no argv was captured: the child never ran" : JSON.stringify(argv),
  );
  const captured = argv ?? [];

  // `--session-id <uuid>` is the descriptor's stable argv tail, and the host
  // appends any initial prompt after it, so everything before it is exactly the
  // generated-flags-then-extra-args region the case is about.
  const sessionIdIndex = captured.indexOf("--session-id");
  observe(
    STEPS.S008,
    "S008-O01",
    sessionIdIndex >= 0 &&
      JSON.stringify(captured.slice(0, sessionIdIndex)) === JSON.stringify(EXPECTED_ARGV_PREFIX),
    `argv begins with the generated flags then the extra arguments: ${EXPECTED_ARGV_PREFIX.join(" ")}`,
    sessionIdIndex < 0
      ? `no --session-id tail in ${JSON.stringify(captured)}`
      : JSON.stringify(captured.slice(0, sessionIdIndex)),
  );

  // Two separate TRAILING tokens: adjacent, in order, and immediately after the
  // generated flags. A single joined "--fallback-model sonnet" token, or a
  // `--fallback-model=sonnet` rewrite, both fail here.
  const flagIndex = captured.indexOf("--fallback-model");
  observe(
    STEPS.S008,
    "S008-O02",
    flagIndex === 6 && captured[flagIndex + 1] === "sonnet" && sessionIdIndex === flagIndex + 2,
    "argv appends the extra arguments as two separate trailing tokens --fallback-model and sonnet",
    flagIndex < 0
      ? `no --fallback-model token in ${JSON.stringify(captured)}`
      : `index=${flagIndex}, next=${JSON.stringify(captured[flagIndex + 1])}, tail at ${sessionIdIndex}`,
  );

  // S008-O03 is what the child-observed argv is FOR. These two tokens are
  // distinct entries in the array the CLI itself reports, and neither carries
  // whitespace or quoting: a shell between the host and the child would have
  // re-split, de-quoted or expanded them before this point, so their survival as
  // written is the evidence that `pty.spawn` was handed an argv array.
  const extraTokens = captured.slice(6, 8);
  observe(
    STEPS.S008,
    "S008-O03",
    extraTokens.length === 2 &&
      extraTokens.every((token) => !/\s/.test(token)) &&
      extraTokens.join(" ") === EXTRA_ARGS,
    "the command is spawned as an argv array with no shell interpretation of the extra arguments",
    JSON.stringify(extraTokens),
  );
});
