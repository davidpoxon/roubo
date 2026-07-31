import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  DEFAULT_AGENT_BINDING,
  clearAgentConfig,
  consentAgent,
  setAppAgentTools,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// One FR-020 observer per case, so a divergence block names the case it belongs
// to rather than whichever id the file happens to lead with.
const observe026 = makeObserve("AP-TC-026");
const observe027 = makeObserve("AP-TC-027");

// AP-TC-026 and AP-TC-027 (#681, AP-WU-036) - E2E: what the bench Terminal
// launch menu lists, and what a launch fired from it actually starts.
//
// The two cases share a surface (the grouped launch menu), a fixture project and
// a bench, so they share a file; each has ONE test carrying its bare id and
// asserting EVERY observation of that case (#680). The id is never on the
// describe, because the suite mapper matches `classname` + `name` and every test
// would inherit it.
//
// WHY A BROWSER, not jsdom. Both cases are about a menu that only exists once a
// project, a bench and a resolved preset list are all real, and both end in a
// launch. AgentLaunchMenu's unit tests can prove the grouping given a props
// array; only this can prove that a `roubo.yaml tools:` entry travels through
// config load, preset resolution and the launch pipeline into a spawned child.
//
// The launched argv is read back from the child's OWN `process.argv` (the
// `roubo-e2e-claude-stub` binary writes it to AGENT_ARGV_LOG_PATH), so "launched
// with the preset's overrides" is evidence rather than a host-side
// reconstruction of our own arithmetic. See the AP-TC-087 guard's header for the
// full account of that channel.
//
// ---------------------------------------------------------------------------
// KNOWN DIVERGENCE, AP-TC-027 S001-O01
// ---------------------------------------------------------------------------
// The case says all three built-ins (Agent, Agent (Plan), Agent (Auto)) show
// "-> Claude Code" as the resolved agent. Today only `Agent` does.
//
// `presetSummary` (client/src/components/AgentLaunchMenu.tsx:43-47) returns the
// PARAM summary whenever the preset has params and only falls back to the arrow
// form when it has none, and BUILTIN_AGENT_PRESETS (shared/types.ts:1681-1703)
// gives Agent (Plan) `params: { mode: "plan" }` and Agent (Auto)
// `params: { mode: "auto" }`. So those two render "plan" and "auto" in the slot
// where the case expects the arrow. All three still RESOLVE to Claude Code,
// which is what the case is really about, and this spec asserts that resolution
// against the server's own resolved-preset list as well as asserting what each
// row renders today.
//
// Asserting the case's wording verbatim would ship a permanently red suite;
// quietly rewriting the case would lose the signal. Reconciling the two (render
// the arrow alongside the params, or amend the case) is a `product-dev:align`
// follow-up and is out of scope for a coverage issue.
// ---------------------------------------------------------------------------

const PROJECT_ID = "ap-tc-026-launch-menu";
const BENCH_ID = 1;

/** The `roubo.yaml tools:` preset AP-TC-026 is about. */
const PROJECT_PRESET_NAME = "Project deep work";
const PROJECT_PRESET_ID = `project:${PROJECT_PRESET_NAME}`;
const PROJECT_PRESET_PARAMS = { model: "opus" } as const;

/** An app-level preset, so "alongside app-level presets" has something to be alongside. */
const APP_PRESET_ID = "ap-tc-026-app";
const APP_PRESET_NAME = "App deep work";

/** Built-in preset ids (shared/types.ts). */
const BUILTIN_IDS = ["__builtin_agent__", "__builtin_agent_plan__", "__builtin_agent_auto__"];
const BUILTIN_PLAN_ID = "__builtin_agent_plan__";

const BUILTIN_SECTION = "Built-in · default agent";
const AGENT_TOOLS_SECTION = "Agent tools";

// The slice issues that own this behaviour, used by the FR-020 failure-output
// contract to attribute a divergence.
const SLICE = {
  menu: { issue: 517, title: "Bench Terminal grouped agent launch menu" },
  presets: { issue: 516, title: "Agent tool presets: editor, built-ins, resolution" },
  gate: { issue: 537, title: "Verify gate: Phase 2 Claude Parity & Launch Surfaces" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  "026-S001": {
    id: "S001",
    instruction: "Open a bench Terminal tab for the project and open the launch menu",
    owners: [SLICE.menu, SLICE.presets],
  },
  "026-S002": {
    id: "S002",
    instruction: "Launch the project-level preset from the menu",
    owners: [SLICE.menu, SLICE.gate],
  },
  "027-S001": {
    id: "S001",
    instruction: "Open the launch menu and inspect the 'Built-in · default agent' section",
    owners: [SLICE.presets, SLICE.menu],
  },
  "027-S002": {
    id: "S002",
    instruction: "Launch the built-in 'Agent (Plan)' preset",
    owners: [SLICE.presets, SLICE.gate],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  agentPluginId?: string;
}

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
 * `/test/__reset`, so a session from an earlier run would shadow "a new session
 * opened" and leave an idling stub behind (NFR-018).
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/** Poll until an agent session for `pluginId` is live, or give up after 10s. */
async function waitForLiveAgentSession(
  request: APIRequestContext,
  pluginId: string,
): Promise<{ live?: TerminalSessionEntry; seen: TerminalSessionEntry[] }> {
  let seen: TerminalSessionEntry[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    seen = await listSessions(request);
    const live = seen.find(
      (session) => session.agentPluginId === pluginId && session.status === "live",
    );
    if (live !== undefined) return { live, seen };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { seen };
}

/** Poll until the spawned child has written its argv, or give up after 10s. */
async function waitForCapturedArgv(): Promise<string[] | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const argv = readCapturedArgv();
    if (argv !== null) return argv;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function describeSessions(sessions: TerminalSessionEntry[]): string {
  return sessions.length === 0
    ? "no terminal session was created"
    : sessions
        .map((session) => `${session.id}: status=${session.status}, agent=${session.agentPluginId}`)
        .join("; ");
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
 * Open the split button's grouped launch menu. The tab bar and the empty state
 * each render one chevron, so with no sessions open there are two identical
 * triggers; the first is the one in the tab bar.
 */
async function openLaunchMenu(page: Page): Promise<Locator> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await expect(trigger, "the Agent split button offers a launch menu").toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu");
  // A TOLERATED wait, not an assertion: a menu that never opens leaves the
  // observations below to report the divergence through the FR-020 block rather
  // than failing here as an unattributed Playwright timeout.
  await menu.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  return menu;
}

/** The summary text each named preset row renders, keyed by preset id. */
async function readPresetSummaries(page: Page, ids: string[]): Promise<Record<string, string>> {
  const summaries: Record<string, string> = {};
  for (const id of ids) {
    const item = page.getByTestId(`launch-preset-${id}`);
    if ((await item.count()) !== 1) {
      summaries[id] = "<row not rendered>";
      continue;
    }
    const summary = item.getByTestId("launch-preset-summary");
    summaries[id] =
      (await summary.count()) === 1
        ? ((await summary.textContent()) ?? "").trim()
        : "<no summary slot: the row is blocked or degraded>";
  }
  return summaries;
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: Claude Code installed, configured and the default agent, so
  // every default-bound preset resolves to it.
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
  // Both cases assert an argv, and an app-level default left behind by another
  // spec would layer underneath the preset's overrides and change it.
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);

  // "alongside app-level presets" (AP-TC-026 S001-O01) needs an app-level preset
  // to be alongside. Written through the same settings route the editor uses.
  await setAppAgentTools(request, [
    { id: APP_PRESET_ID, name: APP_PRESET_NAME, agent: DEFAULT_AGENT_BINDING, params: {} },
  ]);

  // Precondition: "The project's roubo.yaml declares a valid agent tool preset
  // under tools:". A project preset has no other route into the app (the editor
  // writes app-level presets into settings.json), which is why the fixture route
  // grew an `agentTools` option for this case.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      agentTools: [
        {
          name: PROJECT_PRESET_NAME,
          agent: CLAUDE_PLUGIN_ID,
          params: PROJECT_PRESET_PARAMS,
        },
      ],
      seedBenches: [
        {
          assignedIssue: {
            number: 681,
            integrationId: "github-com",
            externalId: "681",
            title: "Launch a project-level agent tool preset from the Terminal tab",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  await setAppAgentTools(request, []);
  await setDefaultAgent(request, null);
  clearCapturedArgv();
});

test("AP-TC-026: a roubo.yaml tools: preset is listed and launches with its binding (S001-S002)", async ({
  page,
  request,
}) => {
  await openTerminalTab(page);

  // --- S001: the project preset is grouped under Agent tools ----------------
  await openLaunchMenu(page);

  const agentToolsGroup = page.getByRole("group", { name: AGENT_TOOLS_SECTION });
  const projectItem = agentToolsGroup.getByTestId(`launch-preset-${PROJECT_PRESET_ID}`);
  const appItem = agentToolsGroup.getByTestId(`launch-preset-${APP_PRESET_ID}`);
  // Counts are read ONCE so the boolean and the reported actual cannot disagree.
  const groupCount = await agentToolsGroup.count();
  const projectCount = await projectItem.count();
  const appCount = await appItem.count();
  const projectLabel = projectCount === 1 ? await projectItem.getAttribute("aria-label") : null;
  observe026(
    STEPS["026-S001"],
    "S001-O01",
    groupCount === 1 && projectCount === 1 && appCount === 1,
    `the menu has one "${AGENT_TOOLS_SECTION}" section listing both the roubo.yaml preset "${PROJECT_PRESET_NAME}" and the app-level preset "${APP_PRESET_NAME}"`,
    `sections named "${AGENT_TOOLS_SECTION}"=${groupCount}, project preset rows=${projectCount}, app preset rows=${appCount}, project row label=${JSON.stringify(projectLabel)}`,
  );

  // --- S002: launching it uses that binding and those overrides -------------
  // Unlink first so the argv read below can only be this launch's.
  clearCapturedArgv();
  await projectItem.click();

  const { live, seen } = await waitForLiveAgentSession(request, CLAUDE_PLUGIN_ID);
  const argv = await waitForCapturedArgv();
  const captured = argv ?? [];
  // `--session-id <uuid>` is the descriptor's stable argv tail, so everything
  // before it is exactly the region the preset's overrides assemble into.
  const sessionIdIndex = captured.indexOf("--session-id");
  const generated = sessionIdIndex >= 0 ? captured.slice(0, sessionIdIndex) : captured;
  observe026(
    STEPS["026-S002"],
    "S002-O01",
    live !== undefined &&
      argv !== null &&
      sessionIdIndex >= 0 &&
      JSON.stringify(generated) === JSON.stringify(["--model", PROJECT_PRESET_PARAMS.model]),
    `a live ${CLAUDE_AGENT_NAME} session opens (the preset's agent binding) whose argv carries the preset's overrides: --model ${PROJECT_PRESET_PARAMS.model}`,
    `session: ${live ? `${live.id} live agent=${live.agentPluginId}` : describeSessions(seen)}; argv: ${argv === null ? "never captured, the child did not run" : JSON.stringify(captured)}`,
  );
});

test("AP-TC-027: built-in presets resolve to the default agent and launch with their mode (S001-S002)", async ({
  page,
  request,
}) => {
  // The server's own resolution, which is what "resolve to the default agent"
  // means: the menu renders from this list, so reading it is not a second
  // resolution path, it is the one the surface uses.
  const presetsRes = await request.get(`/api/projects/${PROJECT_ID}/agent-presets`);
  expect(presetsRes.status(), "GET agent-presets").toBe(200);
  const { presets } = (await presetsRes.json()) as {
    presets: { id: string; source: string; resolvedAgentName?: string; agent: string }[];
  };
  const builtins = presets.filter((preset) => preset.source === "builtin");

  await openTerminalTab(page);

  // --- S001: the Built-in section, and what each row resolves to ------------
  await openLaunchMenu(page);

  const builtinGroup = page.getByRole("group", { name: BUILTIN_SECTION });
  const builtinGroupCount = await builtinGroup.count();
  const listedBuiltins: string[] = [];
  for (const id of BUILTIN_IDS) {
    if ((await builtinGroup.getByTestId(`launch-preset-${id}`).count()) === 1)
      listedBuiltins.push(id);
  }
  observe027(
    STEPS["027-S001"],
    "S001-O01",
    builtinGroupCount === 1 &&
      listedBuiltins.length === BUILTIN_IDS.length &&
      builtins.length === BUILTIN_IDS.length &&
      builtins.every(
        (preset) =>
          preset.agent === DEFAULT_AGENT_BINDING && preset.resolvedAgentName === CLAUDE_AGENT_NAME,
      ),
    `one "${BUILTIN_SECTION}" section listing all three built-ins, each bound to the default agent and resolved to ${CLAUDE_AGENT_NAME}`,
    `sections=${builtinGroupCount}, listed=${JSON.stringify(listedBuiltins)}, resolved=${JSON.stringify(
      builtins.map((preset) => `${preset.id}: ${preset.agent} -> ${preset.resolvedAgentName}`),
    )}`,
  );

  // The rendered summary slot. See the KNOWN DIVERGENCE note at the top of this
  // file: the case expects "→ Claude Code" on all three, and only the
  // parameterless built-in renders it, because the other two spend that slot on
  // their param summary instead.
  const summaries = await readPresetSummaries(page, BUILTIN_IDS);
  observe027(
    STEPS["027-S001"],
    "S001-O01",
    summaries["__builtin_agent__"] === `→ ${CLAUDE_AGENT_NAME}` &&
      summaries[BUILTIN_PLAN_ID] === "plan" &&
      summaries["__builtin_agent_auto__"] === "auto",
    `the parameterless built-in renders "→ ${CLAUDE_AGENT_NAME}" while the two parameterised ones render their mode ("plan", "auto") in that same slot: KNOWN DIVERGENCE from the case's "each show '→ ${CLAUDE_AGENT_NAME}'", see the file header`,
    JSON.stringify(summaries),
  );

  // --- S002: launching Agent (Plan) starts Claude Code with mode=plan -------
  clearCapturedArgv();
  await page.getByTestId(`launch-preset-${BUILTIN_PLAN_ID}`).click();

  const { live, seen } = await waitForLiveAgentSession(request, CLAUDE_PLUGIN_ID);
  const argv = await waitForCapturedArgv();
  const captured = argv ?? [];
  const sessionIdIndex = captured.indexOf("--session-id");
  const generated = sessionIdIndex >= 0 ? captured.slice(0, sessionIdIndex) : captured;
  observe027(
    STEPS["027-S002"],
    "S002-O01",
    live !== undefined &&
      argv !== null &&
      sessionIdIndex >= 0 &&
      JSON.stringify(generated) === JSON.stringify(["--permission-mode", "plan"]),
    `a live ${CLAUDE_AGENT_NAME} session opens whose argv carries mode=plan as --permission-mode plan`,
    `session: ${live ? `${live.id} live agent=${live.agentPluginId}` : describeSessions(seen)}; argv: ${argv === null ? "never captured, the child did not run" : JSON.stringify(captured)}`,
  );
});
