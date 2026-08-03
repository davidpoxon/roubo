import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CODEX_ARGV_LOG_PATH,
  clearCapturedCodexArgv,
  readCapturedCodexArgv,
} from "./_support/argv-log.js";
import {
  CODEX_AGENT_NAME,
  CODEX_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  createAppJig,
  deleteAppJig,
  disablePlugin,
  enablePlugin,
  setAgentConfig,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// AP-TC-056 + AP-TC-105 (#532, AP-WU-031) - E2E: a Codex session launches with
// the configured settings, injects the jig through the plugin's declared
// mechanism, and raises waiting then exited through the quiescence heuristic.
//
// The integration-level drift guard for the AP-US-009 journey (AP-FR-012,
// AP-FR-013, AP-FR-020), spanning the slices this unit is blocked by (#505,
// #512, #513, #520). It walks both authoritative e2e_flow cases step for step
// against the REAL built app. On divergence each observation routes through the
// FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s). Each case
// binds its OWN observer, so a divergence block names AP-TC-056 or AP-TC-105
// rather than a shared label.
//
// ONE test carries each bare case id and it asserts EVERY observation of that
// case (#680): the suite mapper corroborates a case only when exactly one test
// claims it, and neither id sits on a `describe`, because the mapper matches
// `classname` + `name` and every test in the file would inherit it.
//
// HOW THE CODEX PLUGIN PRECONDITION IS MET. The shipping plugin lives in the
// sibling `roubo-plugins` repo and builds against the published SDK, so roubo's
// e2e suite cannot depend on it. Instead the agent-kind bundled overlay at
// e2e/fixtures/bundled-overlays/codex-cli/ takes the `codex-cli` id, exactly as
// the `claude-code` overlay takes its own. Since #532 its `configSchema` is
// copied from the real manifest, so the AI Agents card renders the real Model /
// Reasoning effort / Approval policy / Sandbox selects, and its `translateLaunch`
// mirrors the real `buildArgs` ordering and the real `waitingDetection` window.
// The overlay is force-DISABLED by every /test/__reset
// (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts), so this spec opts
// it in and hands it back disabled: consent has no revoke route and outlives the
// server process, so a second available agent left behind would un-resolve the
// lone-agent fallback other specs depend on (NFR-018).
//
// PARTIAL CIRCULARITY, stated plainly: because the overlay implements the argv
// mapping, this guard cannot prove the shipped plugin's `buildArgs`. That
// mapping is unit-covered in roubo-plugins. What this guard proves is the
// HOST-side integrated path, which nothing else covers end to end: the AI Agents
// form persisting app-level Codex defaults, the launch resolving them through
// the four-layer config, the values reaching the spawned CLI as separate argv
// tokens, the jig arriving through the plugin's ONLY declared injection
// mechanism, and the plugin's declared quiescence window deciding when the
// session reads as waiting.
//
// WHY THE ARGV IS READ FROM A FILE. Both cases ask what the assembled launch
// command actually was. No API surfaces a session's argv, and reconstructing it
// host-side would assert our own arithmetic rather than the child's reality. The
// overlay's descriptor names a stub binary (e2e/fixtures/bin/roubo-e2e-codex-stub,
// deliberately NOT called `codex` so a real install cannot win the PATH lookup)
// which writes its OWN `process.argv.slice(2)` as JSON to CODEX_ARGV_LOG_PATH.
// That is a DIFFERENT file from the one the AP-TC-087 guard reads, so the two
// guards' evidence cannot race. Asserting over that array is direct evidence for
// "no shell interpretation": a shell would have re-split or expanded the tokens
// before the child ever saw them.
//
// THE TWO CASES DISAGREE ABOUT ARGV EXACTNESS, and the disagreement is resolved
// in favour of the longer argv. AP-TC-056 S001-O02 reads as though the four
// tokens it lists were the WHOLE command line, while AP-TC-105 S005-O03 also
// requires `-c model_reasoning_effort=medium` and the shipped `buildArgs`
// additionally emits `--strict-config` (which turns an unknown Codex config key
// into a hard pre-launch error). Asserting S001-O02 as array equality would
// therefore contradict AP-TC-105, so it is asserted as "these tokens are
// present, in this relative order, each its own argv element". AP-TC-105 S005,
// whose whole subject is the assembled invocation, does assert the generated
// argv exactly.
//
// A STALE PRECONDITION, implemented as its intent. AP-TC-056 names "detected
// codex CLI version 0.48.2", but the shipped plugin's window, the overlay's, and
// the stub's reported version are all in the 0.144.x line (spike #502 surveyed
// @openai/codex 0.144.1, the only version any Roubo work has validated). The
// literal number is stale and below the 0.144.0 floor, so pinning the stub to it
// would block the launch the case is about. The precondition is therefore
// asserted as what it means: the detected version resolves `within-tested-range`.

const PROJECT_ID = "ap-us-009-codex-journey";
// "Bench 2 workspace is provisioned" (AP-TC-056 precondition).
// `/test/__register-fixture-project` writes `seedBenches[i]` with `id: i + 1`,
// so two seeded benches is what makes bench 2 exist. AP-TC-105 asks only for "a
// bench is active", which the same bench satisfies.
const BENCH_ID = 2;

const ALL_AGENTS_SECTION = "All agents";

/** The command the `codex-cli` overlay's launch descriptor names. */
const CODEX_COMMAND = "roubo-e2e-codex-stub";

/**
 * The configuration both cases name: model gpt-5.2-codex, medium effort,
 * on-request approval, workspace-write sandbox.
 */
const CODEX_CONFIG = {
  model: "gpt-5.2-codex",
  effort: "medium",
  approvalPolicy: "on-request",
  sandbox: "workspace-write",
} as const;

/** The option labels the schema's `oneOf` titles render for those four values. */
const CODEX_CHOICE_LABELS = {
  model: "GPT-5.2 Codex",
  effort: "Medium",
  approvalPolicy: "On request",
  sandbox: "Workspace write",
} as const;

/**
 * The generated argv the overlay assembles from {@link CODEX_CONFIG}, in order.
 * AP-TC-105 S005 asserts this exactly; AP-TC-056 S001-O02 asserts a subsequence
 * of it (see the header note on the two cases disagreeing about exactness).
 */
const EXPECTED_GENERATED_ARGV = [
  "--model",
  "gpt-5.2-codex",
  "-c",
  "model_reasoning_effort=medium",
  "-c",
  "approval_policy=on-request",
  "-c",
  "sandbox_mode=workspace-write",
  "--strict-config",
];

/** The tokens AP-TC-056 S001-O02 names, in the relative order it names them. */
const AP_TC_056_ARGV_TOKENS = [
  "--model",
  "gpt-5.2-codex",
  "-c",
  "approval_policy=on-request",
  "-c",
  "sandbox_mode=workspace-write",
];

/**
 * The jig AP-TC-056 S002 observes. Deliberately free of `{{...}}` placeholders,
 * so the resolved content the host injects is the authored content and the
 * observation is about injection rather than templating.
 */
const JIG_NAME = "AP-TC-056 injection probe";
const JIG_MARKER = "ap-tc-056-injection-marker";
const JIG_CONTENT = `Codex jig payload for AP-TC-056 (${JIG_MARKER}). Injected as the trailing argv positional.`;

/**
 * The declared window the overlay mirrors from the shipped plugin. The second
 * confirmation poll waits twice this, so a second notification raised one window
 * later would be caught rather than missed.
 */
const QUIESCENCE_DEBOUNCE_MS = 3000;

/**
 * The floor the observed waiting delay has to clear. Set between the generic
 * terminal debounce (2000ms, what a session with no declared
 * `waitingDetection` would get) and the Codex window (3000ms), so the
 * observation separates "the agent's own window was used" from "the generic one
 * was".
 */
const PER_AGENT_WINDOW_FLOOR_MS = 2500;

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  spike: { issue: 505, title: "Spike: Codex session correlation and quiescence behavior" },
  injection: { issue: 512, title: "Jig injection through the agent plugin injection capability" },
  notifications: {
    issue: 513,
    title: "Agent session notifications: hook-driven and quiescence waiting/exited detection",
  },
  plugin: { issue: 520, title: "Codex CLI agent plugin" },
} as const;

const STEPS_056: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Launch Codex CLI from the Terminal tab All agents menu",
    owners: [SLICE.plugin],
  },
  S002: {
    id: "S002",
    instruction: "Observe the session start",
    owners: [SLICE.injection, SLICE.plugin],
  },
  S003: {
    id: "S003",
    instruction: "Let the agent finish a turn and go idle",
    owners: [SLICE.notifications, SLICE.spike, SLICE.plugin],
  },
  S004: {
    id: "S004",
    instruction: "Let the session end (turn complete, then process exit)",
    owners: [SLICE.notifications],
  },
};

const STEPS_105: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the AI Agents screen and click Configure on the Codex CLI card",
    owners: [SLICE.plugin],
  },
  S002: {
    id: "S002",
    instruction:
      "Set Model=gpt-5.2-codex, Reasoning effort=medium, Approval policy=on-request, Sandbox=workspace-write",
    owners: [SLICE.plugin],
  },
  S003: {
    id: "S003",
    instruction: "Click Save defaults",
    owners: [SLICE.plugin],
  },
  S004: {
    id: "S004",
    instruction:
      "Navigate to the bench Terminal tab, open the Agent launch menu, and choose Codex CLI",
    owners: [SLICE.plugin],
  },
  S005: {
    id: "S005",
    instruction: "Inspect the assembled launch command for the Codex session",
    owners: [SLICE.plugin],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  createdAt: string;
  command?: string;
  agentPluginId?: string;
}

interface NotificationEntry {
  id: string;
  type: string;
  createdAt: string;
  sourceSessionId?: string;
}

/** The jig id minted by beforeEach, read back from the 201 rather than slugged. */
let jigId = "";

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
 * opened", carry its own stale notifications, and leave an idling stub behind
 * (NFR-018).
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/** Poll until a live Codex session exists, or give up after 15s. */
async function waitForLiveCodexSession(
  request: APIRequestContext,
): Promise<{ live?: TerminalSessionEntry; seen: TerminalSessionEntry[] }> {
  let seen: TerminalSessionEntry[] = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    seen = await listSessions(request);
    const live = seen.find(
      (session) => session.agentPluginId === CODEX_PLUGIN_ID && session.status === "live",
    );
    if (live !== undefined) return { live, seen };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { seen };
}

/** Poll until the spawned child has written its argv, or give up after 15s. */
async function waitForCapturedCodexArgv(): Promise<string[] | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const argv = readCapturedCodexArgv();
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

/** The bench's notifications, read back through the real bench route. */
async function readNotifications(request: APIRequestContext): Promise<NotificationEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(res.status(), "GET the bench").toBe(200);
  const body = (await res.json()) as { notifications?: NotificationEntry[] };
  return body.notifications ?? [];
}

/**
 * Every notification raised for one session. Filtered on `sourceSessionId` so a
 * bench-level notification (or another session's) can never stand in for the
 * one under observation.
 */
async function notificationsForSession(
  request: APIRequestContext,
  sessionId: string,
): Promise<NotificationEntry[]> {
  return (await readNotifications(request)).filter((n) => n.sourceSessionId === sessionId);
}

/**
 * Poll until one session raises a notification of `type`, or until `timeoutMs`
 * elapses. Answers whatever that session's notifications were on the last read,
 * so the caller can report the real state rather than "nothing".
 */
async function waitForSessionNotification(
  request: APIRequestContext,
  sessionId: string,
  type: string,
  timeoutMs: number,
): Promise<NotificationEntry[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await notificationsForSession(request, sessionId);
    if (seen.some((n) => n.type === type)) return seen;
    if (Date.now() >= deadline) return seen;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function describeNotifications(notifications: NotificationEntry[]): string {
  return notifications.length === 0
    ? "no notification was raised for this session"
    : notifications.map((n) => `${n.type}@${n.createdAt}`).join("; ");
}

/** Whether `tokens` appear in `argv` in this relative order, each its own element. */
function containsInOrder(argv: string[], tokens: string[]): boolean {
  let cursor = 0;
  for (const token of tokens) {
    const found = argv.indexOf(token, cursor);
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

/** Whether `argv` carries `first` immediately followed by `second`. */
function hasAdjacentPair(argv: string[], first: string, second: string): boolean {
  return argv.some((token, index) => token === first && argv[index + 1] === second);
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
 * Open the split button's grouped launch menu. With no sessions open the tab bar
 * and the empty state each render one chevron, so there are two identical
 * triggers; the first is the one in the tab bar. Every wait here is TOLERATED,
 * not an assertion: a menu that never opens leaves the caller's observation to
 * report the divergence through the FR-020 block rather than failing here as an
 * unattributed Playwright timeout.
 */
async function openLaunchMenu(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // The menu is data-INDEPENDENT: all three MenuSections render before the agent
  // inventory resolves, and the chevron that opens it is never disabled. So
  // waiting on the menu alone would let the row below be read against an empty
  // "All agents" list.
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
}

/**
 * The "All agents" row for one agent. Every row carries the same
 * `launch-agent-item` test id, so the row is identified by its accessible name,
 * which AgentItem builds as `<agent name>: <effective params or blocker>`.
 */
function allAgentsRow(page: Page, agentName: string): Locator {
  return page
    .getByRole("group", { name: ALL_AGENTS_SECTION })
    .getByRole("menuitem", { name: new RegExp(`^${agentName}:`) });
}

/**
 * Launch Codex from the "All agents" section and answer what the launch route
 * reported. The response is captured rather than reconstructed because
 * `jigInjected` / `jigScheduled` are the host's own account of WHICH injection
 * mechanism it used, which is exactly what AP-TC-056 S002 asks about.
 */
async function launchCodexFromAllAgents(
  page: Page,
): Promise<{ jigInjected?: boolean; jigScheduled?: boolean } | null> {
  await openLaunchMenu(page);
  const pending = page
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" && res.url().includes(`/benches/${BENCH_ID}/terminals`),
      { timeout: 30_000 },
    )
    .catch(() => null);
  const row = allAgentsRow(page, CODEX_AGENT_NAME);
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await row.count()) === 0) return null;
  await row.click();
  const response = await pending;
  if (response === null) return null;
  return (await response.json().catch(() => null)) as {
    jigInjected?: boolean;
    jigScheduled?: boolean;
  } | null;
}

/**
 * Pick one closed-choice control on the schema-driven form by its option label.
 *
 * Scoped to the agent's own card, because `config-field-<key>` ids are unique
 * only WITHIN a card: `AgentPluginCard` mounts each disclosure open, so every
 * installed agent renders its form at once and a page-wide locator would match
 * the Claude Code card's `model` control too.
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

/**
 * Set the app-level jig behaviour. Called BEFORE {@link setDefaultAgent}, whose
 * own payload preserves whatever `autoInject` / `autoExecute` / `defaultJigId`
 * it reads back, so the two writes compose rather than clobber.
 */
async function setJigSettings(
  request: APIRequestContext,
  jigs: { autoInject: boolean; autoExecute: boolean; defaultJigId?: string },
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

/** The Codex card's compatibility verdict, as GET /api/agents reports it. */
async function readCodexCompatibility(
  request: APIRequestContext,
): Promise<{ status?: string; detectedVersion?: string }> {
  const res = await request.get("/api/agents");
  expect(res.status(), "GET /api/agents").toBe(200);
  const body = (await res.json()) as {
    agents: { id: string; compatibility?: { status?: string; detectedVersion?: string } }[];
  };
  return body.agents.find((agent) => agent.id === CODEX_PLUGIN_ID)?.compatibility ?? {};
}

test.beforeEach(async ({ request }) => {
  // AP-TC-056 alone spends two full 3000ms quiescence windows waiting, on top of
  // a real launch, a real PTY teardown and two notification polls, which does not
  // fit the config's 30s per-test default. Raised here rather than in
  // playwright.config.ts so the other agent-plugin specs keep the tighter budget.
  test.setTimeout(180_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "The Codex CLI plugin is installed and enabled". The overlay is
  // force-disabled by every /test/__reset (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS), so
  // it is enabled here and handed back disabled in afterEach. It also has to be
  // CONSENTED: `resolveAgent` refuses an unconsented agent before it ever hands
  // out a connection, so without this the card would read unavailable and the
  // launch would 403.
  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CODEX_PLUGIN_ID]);

  // App-level agent defaults live in `~/.roubo-dev/<checkout>/agents/_global/` and
  // are NOT among the files /test/__reset truncates, so a previous run's saved
  // Codex defaults would survive into this one and leave AP-TC-105's form already
  // at the target values with Save disabled. Each test arranges its own starting
  // point from here (NFR-018).
  await clearAgentConfig(request, CODEX_PLUGIN_ID);

  // No jig on a launch unless a test asks for one: an injected jig arrives as a
  // trailing argv positional carrying whitespace, which AP-TC-105 S005-O04 would
  // then have to explain away. AP-TC-056, whose S002 is about injection, turns it
  // back on for itself.
  await setJigSettings(request, { autoInject: false, autoExecute: true });
  // Pinned explicitly rather than left to the lone-available-agent fallback, so
  // the launch menu's built-in section resolves the same way on every run.
  await setDefaultAgent(request, CODEX_PLUGIN_ID);

  // Jigs are NOT among the things /test/__reset clears (see the header of
  // _support/agent-env.ts), so this one is created through the real route and
  // deleted again in afterEach.
  jigId = await createAppJig(request, {
    name: JIG_NAME,
    description: "Fixture jig whose content AP-TC-056 S002 traces into the launch argv.",
    content: JIG_CONTENT,
  });

  // Two seeded benches, so AP-TC-056's "Bench 2" precondition is met literally.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 531,
            integrationId: "github-com",
            externalId: "531",
            title: "A first bench, so the bench under test is the second",
          },
        },
        {
          assignedIssue: {
            number: 532,
            integrationId: "github-com",
            externalId: "532",
            title: "E2E journey AP-US-009: Codex session launches with configured settings",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // Settings first: `DELETE /api/jigs/:id` answers 409 for a jig that is still
  // referenced as the app-level default, so the reference has to go before the
  // jig does.
  await setJigSettings(request, { autoInject: true, autoExecute: true });
  if (jigId !== "") await deleteAppJig(request, jigId);
  await setDefaultAgent(request, null);
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, CODEX_PLUGIN_ID);
  clearCapturedCodexArgv();
});

test("AP-TC-056: a configured Codex session launches, injects its jig, and raises waiting then exited (S001-S004)", async ({
  page,
  request,
}) => {
  // Bind the FR-020 observer to this case's id so its divergence blocks read
  // "AP-TC-056".
  const observe = makeObserve("AP-TC-056");

  // Precondition: "Codex CLI agent plugin is Configured with model gpt-5.2-codex,
  // medium effort, on-request approval, workspace-write sandbox". Written the way
  // the AI Agents card's Save defaults button writes it; AP-TC-105 is the case
  // that drives that form by hand.
  await setAgentConfig(request, CODEX_PLUGIN_ID, { ...CODEX_CONFIG });

  // Precondition: "detected codex CLI version is within the plugin's tested
  // range" (see the header note on the case's stale 0.48.2 literal). Asserted
  // rather than assumed, so a fixture drifting out of the window fails as a
  // missing precondition instead of as a mysterious launch refusal.
  const compatibility = await readCodexCompatibility(request);
  expect(
    compatibility.status,
    `the detected Codex CLI version resolves within-tested-range (detected ${compatibility.detectedVersion ?? "nothing"})`,
  ).toBe("within-tested-range");

  // The jig the injection observation traces. Auto-injection is switched on for
  // this case only, with the fixture jig as the app-level default, so the launch
  // below carries it exactly as a real one would.
  await setJigSettings(request, { autoInject: true, autoExecute: true, defaultJigId: jigId });

  await openTerminalTab(page);

  // A second, plain terminal session, opened BEFORE the launch.
  //
  // `TerminalTabs` dismisses the session notifications of whichever tab is in
  // FRONT, because a user looking straight at a session does not need telling it
  // is waiting. So the notification S003 is about is only observable on a tab
  // that is not focused, and this spare tab is what the Codex tab is swapped for
  // the moment it opens. Pre-creating it makes that swap a single click on an
  // already-rendered tab rather than a race against the 3000ms window. Every pane
  // stays mounted and keeps its WebSocket when it goes to the back, so the Codex
  // session's own quiescence timer is untouched by the switch.
  const shell = await request.post(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`, {
    data: {},
  });
  expect(shell.status(), "POST a plain shell session to hold the foreground").toBe(201);
  const shellTab = page.getByText(`Terminal 1`, { exact: true });
  await shellTab.waitFor({ state: "visible", timeout: 15_000 });

  // --- S001: launching from the All agents menu opens a configured session ---
  // Unlink first so the argv read below can only be this launch's.
  clearCapturedCodexArgv();
  const launchReport = await launchCodexFromAllAgents(page);

  // Send the Codex tab to the back (see above) before its idle window expires.
  // TOLERATED waits: a tab that never renders leaves the observations below to
  // report the divergence with their owning slice.
  await page
    .getByText(`${CODEX_AGENT_NAME} 1`, { exact: true })
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  await shellTab.click().catch(() => {});

  const { live, seen } = await waitForLiveCodexSession(request);
  observe(
    STEPS_056.S001,
    "S001-O01",
    live !== undefined && live.command === CODEX_COMMAND,
    `a PTY session opens running the codex CLI the overlay's descriptor names, "${CODEX_COMMAND}" (status=live, agentPluginId=${CODEX_PLUGIN_ID})`,
    live === undefined
      ? describeSessions(seen)
      : `${live.id}: status=${live.status}, agent=${live.agentPluginId}, command=${live.command}`,
  );

  const argv = await waitForCapturedCodexArgv();
  observe(
    STEPS_056.S001,
    "S001-O02",
    argv !== null,
    `the spawned agent CLI recorded its argv at ${CODEX_ARGV_LOG_PATH}`,
    argv === null ? "no argv was captured: the child never ran" : JSON.stringify(argv),
  );
  const captured = argv ?? [];

  // Asserted as an ordered subsequence rather than as the whole argv: the real
  // `buildArgs` also emits `-c model_reasoning_effort=medium` (AP-TC-105 S005-O03
  // requires it) and `--strict-config`, so equality here would contradict the
  // sibling case. What the case is really about is that each token is its OWN
  // argv element, in this order, which is what this reads.
  observe(
    STEPS_056.S001,
    "S001-O02",
    containsInOrder(captured, AP_TC_056_ARGV_TOKENS),
    `argv carries ${AP_TC_056_ARGV_TOKENS.join(" ")} in that order, each token a separate argv element`,
    JSON.stringify(captured),
  );

  // --- S002: the jig arrives through the plugin's declared mechanism ---------
  // `argv-positional` is the ONLY injection mechanism the overlay declares, and
  // the route reports which one it actually used: `jigInjected` means the content
  // went in as the positional prompt, `jigScheduled` would mean a deferred PTY
  // write instead. Both halves are read, so "and no other mechanism is used" is
  // observed rather than assumed.
  const markerCarriers = captured.filter((token) => token.includes(JIG_MARKER));
  const trailing = captured[captured.length - 1] ?? "";
  observe(
    STEPS_056.S002,
    "S002-O01",
    launchReport?.jigInjected === true &&
      launchReport?.jigScheduled !== true &&
      markerCarriers.length === 1 &&
      trailing.includes(JIG_MARKER),
    "the jig content is injected as the trailing argv positional (the plugin's declared argv-positional mechanism), and no PTY write is scheduled for it",
    `launch reported jigInjected=${String(launchReport?.jigInjected)}, jigScheduled=${String(launchReport?.jigScheduled)}; argv elements carrying the jig marker=${markerCarriers.length}; trailing element=${JSON.stringify(trailing)}`,
  );

  // --- S003: going idle raises exactly one waiting notification --------------
  const sessionId = live?.id ?? "";
  // Generous relative to the 3000ms window: the poll has to survive a slow PTY
  // spawn without ever shortening the window itself, which the delay assertion
  // below measures independently.
  const waiting = await waitForSessionNotification(request, sessionId, "agent-waiting", 30_000);
  const waitingNotifications = waiting.filter((n) => n.type === "agent-waiting");
  const first = waitingNotifications[0];
  const delayMs =
    first !== undefined && live !== undefined
      ? new Date(first.createdAt).getTime() - new Date(live.createdAt).getTime()
      : -1;
  // `agent-waiting` rather than `terminal-waiting` is the half that proves the
  // descriptor's `waitingDetection` reached the host at all: without it
  // `isAgentWaitingSession` is false and the same idle period raises the plain
  // terminal notification. The delay is the half that proves the AGENT's window
  // was used rather than the generic 2000ms terminal debounce.
  observe(
    STEPS_056.S003,
    "S003-O01",
    first !== undefined && delayMs >= PER_AGENT_WINDOW_FLOOR_MS,
    `the quiescence heuristic raises an agent-waiting notification no earlier than the Codex per-agent debounce window (${QUIESCENCE_DEBOUNCE_MS}ms), rather than the generic terminal debounce`,
    first === undefined
      ? describeNotifications(waiting)
      : `agent-waiting raised ${delayMs}ms after the session was created`,
  );

  // Re-read past two further windows: a second notification, had one been raised,
  // would have landed inside that span.
  await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_DEBOUNCE_MS * 2));
  const settled = (await notificationsForSession(request, sessionId)).filter(
    (n) => n.type === "agent-waiting",
  );
  observe(
    STEPS_056.S003,
    "S003-O02",
    waitingNotifications.length === 1 && settled.length === 1,
    "exactly one waiting notification is raised for the session, and it stays one across a further two debounce windows",
    `agent-waiting notifications: ${waitingNotifications.length} at first read, ${settled.length} after a further ${QUIESCENCE_DEBOUNCE_MS * 2}ms`,
  );

  // --- S004: ending the session raises an exited notification ----------------
  const destroy = await request.delete(
    `/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${sessionId}`,
  );
  expect([200, 204], "DELETE the codex terminal session").toContain(destroy.status());

  const exited = await waitForSessionNotification(request, sessionId, "agent-exited", 30_000);
  observe(
    STEPS_056.S004,
    "S004-O01",
    exited.some((n) => n.type === "agent-exited"),
    "an exited notification is raised for the session once its process exits",
    describeNotifications(exited),
  );
});

test("AP-TC-105: configure Codex defaults, launch, and verify the assembled argv (S001-S005)", async ({
  page,
  request,
}) => {
  // Bind the FR-020 observer to this case's id so its divergence blocks read
  // "AP-TC-105".
  const observe = makeObserve("AP-TC-105");

  // A DIFFERENT starting point on all four axes, so S002 is a real edit.
  //
  // Three of the shipped Codex axes carry concrete schema defaults rather than a
  // "send no flag" sentinel, and those defaults are exactly the values this case
  // asks for. `ConfigSchemaForm` shows a schema default for an unsaved field and
  // React Aria's Select raises no change event when the option already selected
  // is chosen again, so on an empty config every click here would be a no-op:
  // Save defaults would stay disabled and S003 would then read a config the host
  // never wrote. Starting elsewhere also makes S003-O01 evidence that the SAVE
  // landed, rather than evidence that the schema defaults were echoed back.
  await setAgentConfig(request, CODEX_PLUGIN_ID, {
    model: "gpt-5.1-codex-mini",
    effort: "low",
    approvalPolicy: "untrusted",
    sandbox: "read-only",
  });

  // --- S001: Configure expands the schema-driven Codex config form -----------
  const settingsRes = await page.goto("/settings#ai-agents");
  expect(settingsRes?.status(), "GET /settings").toBe(200);
  const agentsTab = page.getByRole("tab", { name: "AI Agents" });
  await expect(agentsTab, "the AI Agents settings tab renders").toBeVisible();
  await agentsTab.click();

  const installed = page.getByRole("region", { name: "Installed agent plugins" });
  const card = installed.getByTestId(`agent-plugin-card-${CODEX_PLUGIN_ID}`);
  const disclosure = page.getByTestId(`agent-configure-${CODEX_PLUGIN_ID}`);
  // A TOLERATED wait, not an assertion: a card that never renders leaves all four
  // field counts at 0, which S001-O01 below reports as an attributed divergence
  // rather than as an unattributed Playwright timeout.
  await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

  // The card mounts with its disclosure OPEN (the per-plugin config is the whole
  // point of the screen), so collapse it first and then press Configure. That way
  // the step really is "click Configure" and the observation really is the form
  // appearing, rather than a form that was already there.
  if ((await disclosure.textContent())?.includes("Hide")) {
    await disclosure.click();
    await expect(page.getByTestId(`agent-config-form-${CODEX_PLUGIN_ID}`)).toBeHidden();
  }
  await expect(disclosure, "the collapsed disclosure offers Configure").toHaveText(/Configure/);
  await disclosure.click();

  const form = page.getByTestId(`agent-config-form-${CODEX_PLUGIN_ID}`);
  await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // Counts are scoped to the Codex card and read ONCE, so the boolean and the
  // reported actual can never disagree, and so the Claude Code card's own `model`
  // control cannot inflate them.
  const fieldCounts = {
    model: await card.getByTestId("config-field-model").count(),
    effort: await card.getByTestId("config-field-effort").count(),
    approvalPolicy: await card.getByTestId("config-field-approvalPolicy").count(),
    sandbox: await card.getByTestId("config-field-sandbox").count(),
  };
  observe(
    STEPS_105.S001,
    "S001-O01",
    Object.values(fieldCounts).every((count) => count === 1),
    "the Codex config form expands showing Model, Reasoning effort, Approval policy and Sandbox selects",
    `model=${fieldCounts.model}, effort=${fieldCounts.effort}, approvalPolicy=${fieldCounts.approvalPolicy}, sandbox=${fieldCounts.sandbox}`,
  );

  // --- S002: set the four axes (no observations of its own) ------------------
  await selectChoice(page, card, "model", CODEX_CHOICE_LABELS.model);
  await selectChoice(page, card, "effort", CODEX_CHOICE_LABELS.effort);
  await selectChoice(page, card, "approvalPolicy", CODEX_CHOICE_LABELS.approvalPolicy);
  await selectChoice(page, card, "sandbox", CODEX_CHOICE_LABELS.sandbox);
  await expect(card.getByTestId("config-field-model")).toContainText(CODEX_CHOICE_LABELS.model);
  await expect(card.getByTestId("config-field-effort")).toContainText(CODEX_CHOICE_LABELS.effort);
  await expect(card.getByTestId("config-field-approvalPolicy")).toContainText(
    CODEX_CHOICE_LABELS.approvalPolicy,
  );
  await expect(card.getByTestId("config-field-sandbox")).toContainText(CODEX_CHOICE_LABELS.sandbox);

  // --- S003: Save defaults persists the application-level Codex defaults ------
  const save = page.getByTestId(`agent-config-save-${CODEX_PLUGIN_ID}`);
  await expect(save, "Save defaults is enabled once the draft diverges").toBeEnabled();
  await save.click();
  // TOLERATED wait: the "Saved." indicator is how long to wait for the round
  // trip, not the observation. S003-O01 reads the persisted record back through
  // the real API, so a save that silently failed is reported there with its
  // expected-vs-actual rather than throwing here unattributed.
  await form
    .getByText("Saved.")
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  const configRes = await request.get(`/api/agents/${CODEX_PLUGIN_ID}/config`);
  expect(configRes.status(), "GET /api/agents/codex-cli/config").toBe(200);
  const persisted = ((await configRes.json()) as { config?: Record<string, unknown> }).config ?? {};
  // Compared key by key rather than by serialising the whole object: the form
  // writes keys in click order, and a key-order difference is not a divergence
  // the case is about.
  const persistedMatches = Object.entries(CODEX_CONFIG).every(
    ([key, value]) => persisted[key] === value,
  );
  observe(
    STEPS_105.S003,
    "S003-O01",
    persistedMatches && Object.keys(persisted).length === Object.keys(CODEX_CONFIG).length,
    `application-level Codex defaults persisted as ${JSON.stringify(CODEX_CONFIG)}`,
    `persisted config=${JSON.stringify(persisted)}`,
  );

  // --- S004: launching Codex from the All agents menu opens a PTY session -----
  await openTerminalTab(page);
  // Unlink first so the argv read in S005 can only be this launch's.
  clearCapturedCodexArgv();
  await launchCodexFromAllAgents(page);

  const { live, seen } = await waitForLiveCodexSession(request);
  observe(
    STEPS_105.S004,
    "S004-O01",
    live !== undefined && live.command === CODEX_COMMAND,
    `a new ${CODEX_AGENT_NAME} PTY session opens (status=live, agentPluginId=${CODEX_PLUGIN_ID}, command=${CODEX_COMMAND})`,
    live === undefined
      ? describeSessions(seen)
      : `${live.id}: status=${live.status}, agent=${live.agentPluginId}, command=${live.command}`,
  );

  // --- S005: the argv the spawned CLI actually received ----------------------
  const argv = await waitForCapturedCodexArgv();
  observe(
    STEPS_105.S005,
    "S005-O01",
    argv !== null,
    `the spawned agent CLI recorded its argv at ${CODEX_ARGV_LOG_PATH}`,
    argv === null ? "no argv was captured: the child never ran" : JSON.stringify(argv),
  );
  const captured = argv ?? [];

  observe(
    STEPS_105.S005,
    "S005-O01",
    hasAdjacentPair(captured, "--model", CODEX_CONFIG.model),
    `argv contains --model ${CODEX_CONFIG.model} as two adjacent, separate argv elements`,
    JSON.stringify(captured),
  );

  observe(
    STEPS_105.S005,
    "S005-O02",
    hasAdjacentPair(captured, "-c", `approval_policy=${CODEX_CONFIG.approvalPolicy}`) &&
      hasAdjacentPair(captured, "-c", `sandbox_mode=${CODEX_CONFIG.sandbox}`),
    `argv contains -c approval_policy=${CODEX_CONFIG.approvalPolicy} and -c sandbox_mode=${CODEX_CONFIG.sandbox}, each as an adjacent flag/value pair`,
    JSON.stringify(captured),
  );

  observe(
    STEPS_105.S005,
    "S005-O03",
    hasAdjacentPair(captured, "-c", `model_reasoning_effort=${CODEX_CONFIG.effort}`),
    `argv carries the reasoning effort as a -c model_reasoning_effort=${CODEX_CONFIG.effort} override`,
    JSON.stringify(captured),
  );

  // S005-O04 is what the child-observed argv is FOR. Every element the CLI itself
  // reports is a distinct entry and none carries whitespace or quoting: a shell
  // between the host and the child would have re-split, de-quoted or expanded
  // them before this point, so their survival exactly as the descriptor wrote
  // them is the evidence that `pty.spawn` was handed an argv array. Asserted as
  // equality because this step's whole subject is the assembled invocation, and
  // because with auto-injection off there is no trailing prompt positional.
  observe(
    STEPS_105.S005,
    "S005-O04",
    captured.every((token) => !/\s/.test(token)) &&
      JSON.stringify(captured) === JSON.stringify(EXPECTED_GENERATED_ARGV),
    `the command is spawned as an argv array with no shell interpretation: exactly ${JSON.stringify(EXPECTED_GENERATED_ARGV)}, every token whitespace-free`,
    JSON.stringify(captured),
  );
});
