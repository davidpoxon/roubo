import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedArgv } from "./_support/argv-log.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  CODEX_AGENT_NAME,
  CODEX_PLUGIN_ID,
  DEFAULT_AGENT_BINDING,
  clearAgentConfig,
  consentAgent,
  createAppJig,
  deleteAppJig,
  disablePlugin,
  enablePlugin,
  setAppAgentTools,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-020".
const observe = makeObserve("AP-TC-020");

// AP-TC-020 (#526, AP-WU-025) - E2E: set a default agent, bind one jig, leave
// another unbound, then confirm a jig-driven launch honours the binding first
// and the default second.
//
// The integration-level drift guard for the AP-US-003 journey (AP-FR-005,
// AP-FR-006), spanning the slices this unit is blocked by (#515, #524, #537).
// It walks the authoritative AP-TC-020 e2e_flow steps S001-S005 as ordered,
// attributable observations against the REAL built app. On divergence each
// observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s).
//
// ONE test carries the bare id and it asserts EVERY observation of the case
// (#680): the suite mapper corroborates a case only when exactly one test claims
// it, and the id never sits on a `describe`, because the mapper matches
// `classname` + `name` and every test in the file would inherit it.
//
// WHY A BROWSER, not jsdom. S001-S003 are rendered-surface facts: which tile
// carries the selection, and what each Custom Jigs row's Agent select reads.
// S004-S005 then need those same stored facts to reach a launch, which only
// exists once a project, a bench, two resolvable agent plugins and a spawned PTY
// are all real. Nothing below the browser can prove that the surface a user
// pressed and the agent a session actually ran are the same decision.
//
// HOW THE TWO-AGENT PRECONDITION IS MET. The case needs "Claude Code and Codex
// CLI are both installed and configured", and with a single available agent
// `resolveLaunchAgentId` (server/services/agent-launch-pipeline.ts) falls back to
// it whenever no layer names an agent, which would make S005 pass without the
// default ever being consulted. The second agent is the `codex-cli` bundled
// overlay at e2e/fixtures/bundled-overlays/codex-cli/, force-DISABLED by every
// /test/__reset (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts), so
// this spec opts it in, consents it, and hands it back disabled: consent has no
// revoke route and outlives the server process, so a second available agent left
// behind would un-resolve the lone-agent fallback AP-TC-087 depends on
// (NFR-018). Unlike AP-TC-018, this spec really does LAUNCH through the overlay,
// which it can: its `translateLaunch` answers a real descriptor naming
// `roubo-e2e-codex-stub`, and that stub idles.
//
// HOW THE TWO-JIG PRECONDITION IS MET. "Custom jigs 'Refactor pass' and 'Issue
// triage' exist" needs real app-level jigs, and jigs are NOT among the things
// /test/__reset clears (see the header of _support/agent-env.ts), so both are
// created through `POST /api/jigs` in beforeEach and deleted again in afterEach.
// Both start UNBOUND, which is what makes S002's select a genuine change and
// S003's "no explicit binding" a state the spec never had to arrange.
//
// WHY THE EVIDENCE IS THE SESSION RECORD, not the argv. S004 and S005 ask which
// agent a session RUNS, and `session.agentPluginId` on
// GET /api/projects/:id/benches/:n/terminals is that answer directly. The argv
// channel the AP-TC-087 guard reads cannot serve here: only
// `roubo-e2e-claude-stub` writes AGENT_ARGV_LOG_PATH, the codex stub
// deliberately never does (so the two guards cannot race), which would leave the
// codex half of this case with nothing to read.
//
// WHY EACH LAUNCH IS OBSERVED TWICE. The two launch surfaces resolve the agent
// in different places, and the case is about the resolution, not the button. A
// launch fired from the bench launch menu resolves client-side
// (`targetForJig` in client/src/components/TerminalTabs.tsx) and then sends the
// resolved `agentPluginId` explicitly, which the server honours ahead of its own
// resolution; a `POST /terminals` naming only a jig leaves the whole decision to
// `resolveLaunchAgentId`. Asserting only the first would prove nothing about the
// server, and only the second nothing about the surface a user presses, so both
// legs are observed under the step's single observation id.

const PROJECT_ID = "ap-tc-020-jig-binding";
const BENCH_ID = 1;

/** The two custom jigs the case's preconditions name. */
const REFACTOR_JIG_NAME = "Refactor pass";
const TRIAGE_JIG_NAME = "Issue triage";

/** The label the Agent select shows for a jig carrying no binding (JigRow). */
const DEFAULT_AGENT_LABEL = "Default agent";

/**
 * One app-level agent tool preset per jig, so the launch menu offers a row whose
 * launch is DRIVEN BY that jig. A preset's own `jig` field is the only way a
 * launch surface carries a named jig, and `agent: "default"` with no params is
 * what makes the row redirectable to the jig's binding rather than pinned to an
 * agent of its own (`resolveLaunchTarget`).
 */
const REFACTOR_PRESET_ID = "ap-tc-020-refactor-pass";
const TRIAGE_PRESET_ID = "ap-tc-020-issue-triage";

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  picker: {
    issue: 515,
    title: "Default agent selection and per-jig agent binding in Jigs settings",
  },
  a11y: { issue: 524, title: "Accessibility audit of the agent surfaces (WCAG 2.1 AA)" },
  gate: {
    issue: 537,
    title: "Verify gate: Phase 2 Claude Parity & Launch Surfaces (33 gating cases)",
  },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open Settings, Jigs and select Claude Code as the default agent",
    // #524 owns the accessible names this step locates the surface by (the
    // "Default agent" radiogroup and its radios), so a rename there breaks this
    // step and has to be attributable to it.
    owners: [SLICE.picker, SLICE.a11y],
  },
  S002: {
    id: "S002",
    instruction: "In Custom jigs, set the 'Refactor pass' Agent select to 'Codex CLI'",
    owners: [SLICE.picker, SLICE.a11y],
  },
  S003: {
    id: "S003",
    instruction: "Leave the 'Issue triage' Agent select on 'Default agent'",
    owners: [SLICE.picker, SLICE.a11y],
  },
  S004: {
    id: "S004",
    instruction: "Launch a session driven by the 'Refactor pass' jig",
    owners: [SLICE.picker, SLICE.gate],
  },
  S005: {
    id: "S005",
    instruction: "Launch a session driven by the 'Issue triage' jig",
    owners: [SLICE.picker, SLICE.gate],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  agentPluginId?: string;
}

/** The jig ids minted by beforeEach, read back from each 201 rather than slugged. */
let refactorJigId = "";
let triageJigId = "";

async function listSessions(request: APIRequestContext): Promise<TerminalSessionEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`);
  expect(res.status(), "GET terminals").toBe(200);
  // The route answers with a bare array of TerminalSession, not an envelope.
  const body = (await res.json()) as TerminalSessionEntry[];
  return Array.isArray(body) ? body : [];
}

/**
 * Drop every terminal session on this spec's bench. Live PTY sessions live in a
 * module-level map keyed by project + bench and are NOT cleared by
 * `/test/__reset`, so a session from an earlier run would shadow "the session"
 * each of S004 and S005 is about, and leave an idling stub behind (NFR-018).
 * Called between the four launches too, which is what lets each of them be read
 * as "exactly one agent session, running X".
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/** Poll until at least one live AGENT session exists, or give up after 15s. */
async function waitForLiveAgentSessions(
  request: APIRequestContext,
): Promise<{ live: TerminalSessionEntry[]; seen: TerminalSessionEntry[] }> {
  let seen: TerminalSessionEntry[] = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    seen = await listSessions(request);
    const live = seen.filter(
      (session) => session.agentPluginId !== undefined && session.status === "live",
    );
    if (live.length > 0) return { live, seen };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { live: [], seen };
}

function describeSessions(sessions: TerminalSessionEntry[]): string {
  return sessions.length === 0
    ? "no terminal session was created"
    : sessions
        .map((session) => `${session.id}: status=${session.status}, agent=${session.agentPluginId}`)
        .join("; ");
}

/** Open Settings and switch to the Jigs tab, where both surfaces live. */
async function openJigsTab(page: Page): Promise<void> {
  const res = await page.goto("/settings");
  expect(res?.status(), "GET /settings").toBe(200);
  const tab = page.getByRole("tab", { name: "Jigs" });
  await expect(tab, "the Jigs settings tab renders").toBeVisible();
  await tab.click();
}

/**
 * Pick an option on one Custom Jigs row's Agent select. React Aria's Select
 * renders the trigger as a Button inside the testid'd wrapper and portals its
 * ListBox to the document body, so the option is located at page level.
 */
async function selectJigAgent(page: Page, jigId: string, optionLabel: string): Promise<void> {
  await page.getByTestId(`jig-agent-select-${jigId}`).locator("button").click();
  await page.getByRole("option", { name: optionLabel, exact: true }).click();
}

/**
 * What one Custom Jigs row's Agent select currently reads.
 *
 * `expected` settles the read against a label the caller has just CHANGED. The
 * trigger's label is fully server-round-tripped (`Select` holds no internal
 * selection state, `JigRow` renders `jig.agentPluginId` straight from
 * `useGlobalJigs`, and `useUpdateGlobalJig` has no optimistic `onMutate`), so it
 * cannot move until `PUT /api/jigs/:id` and the follow-up refetch both land.
 * Without this the read would race two HTTP round trips against a few Playwright
 * IPC calls and normally win, reporting the pre-change label. S003 passes no
 * `expected`, because that row is never mutated.
 */
async function readJigAgentSelect(page: Page, jigId: string, expected?: string): Promise<string> {
  const trigger = page.getByTestId(`jig-agent-select-${jigId}`).locator("button");
  // Both waits below are TOLERATED, not assertions: a row that never renders, or
  // a label that never arrives, leaves the string below at its pre-change (or
  // empty) value, which the observation reports as an attributed divergence
  // rather than an unattributed Playwright timeout.
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if (expected !== undefined) {
    await expect(trigger)
      .toHaveText(expected, { timeout: 15_000 })
      .catch(() => {});
  }
  return (await trigger.count()) === 1 ? ((await trigger.textContent()) ?? "").trim() : "";
}

/** The jig as it was actually persisted, read back through the real route. */
async function readPersistedJig(
  request: APIRequestContext,
  jigId: string,
): Promise<{ agentPluginId?: string }> {
  const res = await request.get(`/api/jigs/${jigId}`);
  expect(res.status(), `GET /api/jigs/${jigId}`).toBe(200);
  return (await res.json()) as { agentPluginId?: string };
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
 * Fire a jig-driven launch from the bench launch menu. Every wait here is
 * TOLERATED: a menu or a row that never appears leaves no session behind, which
 * the caller's observation reports with its expected-vs-actual and owning slice.
 */
async function launchPresetFromMenu(page: Page, presetId: string): Promise<void> {
  await openTerminalTab(page);
  // The tab bar and the empty state each render one chevron, so with no sessions
  // open there are two identical triggers; the first is the tab bar's.
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await trigger.count()) !== 1) return;
  await trigger.click();
  const row = page.getByRole("menu").getByTestId(`launch-preset-${presetId}`);
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await row.count()) === 1) await row.click();
}

/**
 * Fire the same jig-driven launch with no agent named at all, so the SERVER
 * resolves it. This is the leg the client cannot stand in for: the menu sends a
 * resolved `agentPluginId`, which the route honours ahead of `resolveLaunchAgentId`.
 */
async function launchJigViaApi(
  request: APIRequestContext,
  jigId: string,
): Promise<{ status: number; error?: string }> {
  const res = await request.post(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`, {
    data: { jigId },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status(), ...(body.error !== undefined && { error: body.error }) };
}

test.beforeEach(async ({ request }) => {
  // The journey drives two settings surfaces and then FOUR real PTY launches
  // (two per step, see the header), which does not fit the config's 30s
  // per-test default. Raised here rather than in playwright.config.ts so the
  // other agent-plugin specs keep the tighter budget.
  test.setTimeout(180_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "Claude Code and Codex CLI are both installed and configured".
  // The reset left the second-agent overlay disabled, so it is opted in here and
  // both are consented, which is what makes `resolveAgent` hand out a connection
  // for each of them.
  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID]);

  // No default agent to start with, so S001's click is a genuine change rather
  // than a confirmation of a default a previous spec left in settings.json.
  // With two available agents there is no lone-agent fallback to stand in for
  // it either, so nothing is selected until S001 selects it.
  await setDefaultAgent(request, null);
  // An app-level agent config left behind by the AP-TC-087 journey would layer
  // under every launch below; nothing here asserts an argv, but a below-floor or
  // rejected value would refuse the launch these steps are about.
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);

  // Precondition: "Custom jigs 'Refactor pass' and 'Issue triage' exist". Both
  // start UNBOUND: S002 binds one through the UI and S003 observes that the
  // other was left alone.
  refactorJigId = await createAppJig(request, {
    name: REFACTOR_JIG_NAME,
    description: "AP-TC-020 fixture: the jig that carries an explicit agent binding.",
    content: "Refactor the code on this bench.",
  });
  triageJigId = await createAppJig(request, {
    name: TRIAGE_JIG_NAME,
    description: "AP-TC-020 fixture: the jig that follows the default agent.",
    content: "Triage the issue assigned to this bench.",
  });

  // One launch-menu row per jig. `agent: "default"` with no params is what makes
  // each row follow the jig it carries (the redirect in `resolveLaunchTarget`),
  // so the menu asks the same question of the client that `POST /terminals`
  // asks of the server.
  await setAppAgentTools(request, [
    {
      id: REFACTOR_PRESET_ID,
      name: `${REFACTOR_JIG_NAME} launch`,
      agent: DEFAULT_AGENT_BINDING,
      params: {},
      jig: refactorJigId,
    },
    {
      id: TRIAGE_PRESET_ID,
      name: `${TRIAGE_JIG_NAME} launch`,
      agent: DEFAULT_AGENT_BINDING,
      params: {},
      jig: triageJigId,
    },
  ]);

  // A seeded bench carries a real tmpdir workspace, which is all
  // `isBenchOperable` asks of it, so the journey needs no worktree provisioning
  // and no bench start.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 526,
            integrationId: "github-com",
            externalId: "526",
            title: "Set default agent, bind a jig, and launch",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  // Hand the environment back the way it was found: no sessions, no presets, no
  // default agent, no custom jigs, and exactly one available agent again.
  await destroyAllSessions(request);
  await setAppAgentTools(request, []);
  await setDefaultAgent(request, null);
  if (refactorJigId) await deleteAppJig(request, refactorJigId);
  if (triageJigId) await deleteAppJig(request, triageJigId);
  refactorJigId = "";
  triageJigId = "";
  await disablePlugin(request, CODEX_PLUGIN_ID);
  // The Claude stub writes the shared argv log on every launch above; unlink it
  // so AP-TC-087 can never read one of ours.
  clearCapturedArgv();
});

test("AP-TC-020: a bound jig launches its agent and an unbound jig launches the default (S001-S005)", async ({
  page,
  request,
}) => {
  // --- S001: Claude Code becomes the default agent ---------------------------
  await openJigsTab(page);

  const group = page.getByRole("radiogroup", { name: "Default agent" });
  const claudeTile = page.getByTestId(`default-agent-tile-${CLAUDE_PLUGIN_ID}`);
  const codexTile = page.getByTestId(`default-agent-tile-${CODEX_PLUGIN_ID}`);
  // TOLERATED waits: a picker that never renders leaves the reads below at their
  // empty values, which S001-O01 reports as an attributed divergence rather than
  // failing here as an unattributed Playwright timeout.
  //
  // BOTH tiles are waited on, not just the one about to be clicked. The picker
  // renders one tile per available agent as `GET /api/agents` resolves in the
  // client, so the Codex tile can mount a beat after the Claude tile; reading
  // `data-selected` off it before then answers null (the attribute is absent
  // because the element is), and S001-O01 asserts the string "false".
  await claudeTile.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await codexTile.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // The tile, not the radio input: React Aria renders a zero-size input inside
  // the label, so the tile covering it is both what a user presses and the only
  // thing a click can land on.
  if ((await claudeTile.count()) === 1) await claudeTile.click();

  // Read the selection once, so the boolean and the reported actual can never
  // disagree. `data-selected` mirrors the same `isSelected` that drives the
  // highlight and the check indicator, so it is the visual state rather than a
  // second source of truth.
  // Guarded on a non-waiting `count()`, like every other tolerated read in this
  // file: `getAttribute` carries no default timeout (`actionTimeout` is unset in
  // playwright.config.ts), so on a tile that never rendered it would block for
  // the rest of the 180s budget and die as an unattributed Playwright timeout,
  // which is precisely what the tolerated waits above exist to avoid.
  const claudeSelected =
    (await claudeTile.count()) === 1
      ? await claudeTile.getAttribute("data-selected").catch(() => null)
      : null;
  const codexSelected =
    (await codexTile.count()) === 1
      ? await codexTile.getAttribute("data-selected").catch(() => null)
      : null;
  observe(
    STEPS.S001,
    "S001-O01",
    claudeSelected === "true" && codexSelected === "false",
    `the ${CLAUDE_AGENT_NAME} tile is selected as the default agent and the ${CODEX_AGENT_NAME} tile is not`,
    `claude data-selected=${claudeSelected}, codex data-selected=${codexSelected}`,
  );

  const radios = await group.getByRole("radio").all();
  const checked: string[] = [];
  for (const radio of radios) {
    if (await radio.isChecked()) checked.push((await radio.getAttribute("value")) ?? "?");
  }
  observe(
    STEPS.S001,
    "S001-O01",
    radios.length >= 2 && checked.length === 1 && checked[0] === CLAUDE_PLUGIN_ID,
    `exactly one of the ${radios.length} default-agent tiles is selected, and it is ${CLAUDE_PLUGIN_ID}`,
    `${radios.length} tiles, selected: ${checked.length === 0 ? "none" : checked.join(", ")}`,
  );

  // The persisted record, not the form's optimistic state: S005 falls back to
  // THIS value, so a selection that never reached settings.json would otherwise
  // only surface two steps later as a mystery.
  const settingsRes = await request.get("/api/settings");
  expect(settingsRes.status(), "GET /api/settings").toBe(200);
  const persistedDefault = (
    (await settingsRes.json()) as { jigs?: { defaultAgentPluginId?: string } }
  ).jigs?.defaultAgentPluginId;
  observe(
    STEPS.S001,
    "S001-O01",
    persistedDefault === CLAUDE_PLUGIN_ID,
    `the app-level default agent persists as ${CLAUDE_PLUGIN_ID}`,
    `settings.jigs.defaultAgentPluginId=${JSON.stringify(persistedDefault)}`,
  );

  // --- S002: 'Refactor pass' is bound to Codex CLI ---------------------------
  await selectJigAgent(page, refactorJigId, CODEX_AGENT_NAME);

  // Settling on the new label first is also what makes the persisted read below
  // safe: the label cannot move until the PUT has landed.
  const refactorSelectText = await readJigAgentSelect(page, refactorJigId, CODEX_AGENT_NAME);
  const refactorPersisted = await readPersistedJig(request, refactorJigId);
  observe(
    STEPS.S002,
    "S002-O01",
    refactorSelectText === CODEX_AGENT_NAME && refactorPersisted.agentPluginId === CODEX_PLUGIN_ID,
    `the '${REFACTOR_JIG_NAME}' row shows ${CODEX_AGENT_NAME} as its bound agent and persists agentPluginId=${CODEX_PLUGIN_ID}`,
    `select reads ${JSON.stringify(refactorSelectText)}, persisted agentPluginId=${JSON.stringify(
      refactorPersisted.agentPluginId,
    )}`,
  );

  // --- S003: 'Issue triage' is left on Default agent -------------------------
  // Nothing is clicked here: the step is that the row was LEFT alone, so the
  // observation is that the untouched row still reads the sentinel and still
  // carries no stored binding.
  const triageSelectText = await readJigAgentSelect(page, triageJigId);
  const triagePersisted = await readPersistedJig(request, triageJigId);
  observe(
    STEPS.S003,
    "S003-O01",
    triageSelectText === DEFAULT_AGENT_LABEL && triagePersisted.agentPluginId === undefined,
    `the '${TRIAGE_JIG_NAME}' row shows "${DEFAULT_AGENT_LABEL}" and carries no explicit binding`,
    `select reads ${JSON.stringify(triageSelectText)}, persisted agentPluginId=${JSON.stringify(
      triagePersisted.agentPluginId,
    )}`,
  );

  // --- S004: a 'Refactor pass' launch runs Codex CLI -------------------------
  // Leg one: the launch menu, where the CLIENT resolves the jig's binding.
  await destroyAllSessions(request);
  await launchPresetFromMenu(page, REFACTOR_PRESET_ID);
  let { live, seen } = await waitForLiveAgentSessions(request);
  observe(
    STEPS.S004,
    "S004-O01",
    live.length === 1 && live[0].agentPluginId === CODEX_PLUGIN_ID,
    `launching the '${REFACTOR_JIG_NAME}' jig from the bench launch menu opens exactly one live agent session and it runs ${CODEX_AGENT_NAME} (${CODEX_PLUGIN_ID}), the jig's explicit binding, not the default agent (${CLAUDE_PLUGIN_ID})`,
    describeSessions(seen),
  );

  // Leg two: the same jig with no agent named, so the SERVER resolves it.
  await destroyAllSessions(request);
  const refactorApi = await launchJigViaApi(request, refactorJigId);
  ({ live, seen } = await waitForLiveAgentSessions(request));
  observe(
    STEPS.S004,
    "S004-O01",
    refactorApi.status === 201 && live.length === 1 && live[0].agentPluginId === CODEX_PLUGIN_ID,
    `a launch naming only the '${REFACTOR_JIG_NAME}' jig, with no agent for the server to honour, is accepted (201) and runs ${CODEX_PLUGIN_ID}`,
    `POST /terminals status=${refactorApi.status}${
      refactorApi.error !== undefined ? ` (${refactorApi.error})` : ""
    }; ${describeSessions(seen)}`,
  );

  // --- S005: an 'Issue triage' launch falls back to the default agent --------
  await destroyAllSessions(request);
  await launchPresetFromMenu(page, TRIAGE_PRESET_ID);
  ({ live, seen } = await waitForLiveAgentSessions(request));
  observe(
    STEPS.S005,
    "S005-O01",
    live.length === 1 && live[0].agentPluginId === CLAUDE_PLUGIN_ID,
    `launching the '${TRIAGE_JIG_NAME}' jig from the bench launch menu opens exactly one live agent session and it runs ${CLAUDE_AGENT_NAME} (${CLAUDE_PLUGIN_ID}), the default agent, because the jig sets no binding`,
    describeSessions(seen),
  );

  await destroyAllSessions(request);
  const triageApi = await launchJigViaApi(request, triageJigId);
  ({ live, seen } = await waitForLiveAgentSessions(request));
  observe(
    STEPS.S005,
    "S005-O01",
    triageApi.status === 201 && live.length === 1 && live[0].agentPluginId === CLAUDE_PLUGIN_ID,
    `a launch naming only the '${TRIAGE_JIG_NAME}' jig, with no agent for the server to honour, is accepted (201) and falls back to the default agent ${CLAUDE_PLUGIN_ID}`,
    `POST /terminals status=${triageApi.status}${
      triageApi.error !== undefined ? ` (${triageApi.error})` : ""
    }; ${describeSessions(seen)}`,
  );
});
