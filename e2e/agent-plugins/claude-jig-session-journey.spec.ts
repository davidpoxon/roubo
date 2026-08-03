import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  createProjectJig,
  fireWaitingHook,
  setAgentConfig,
  setAppAgentTools,
  setDefaultAgent,
  waitForAvailableAgents,
  waitForBenchNotification,
  waitForNoBenchNotification,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-055".
const observe = makeObserve("AP-TC-055");

// AP-TC-055 (#530, AP-WU-029) - E2E: a jig-driven agent session injects its
// prompt, fires the notification hook, and raises waiting then exited
// notifications.
//
// One of the three integration-level drift guards for the AP-US-007 journey
// (AP-FR-012, AP-FR-013). It walks the authoritative AP-TC-055 e2e_flow steps
// S001-S005 as ordered, attributable observations against the REAL built app. On
// divergence each observation routes through the FR-020 failure-output contract
// (see ../component-plugins/_support/step-runner.ts): the failure reports which
// step diverged, the expected-vs-actual, and the owning slice issue(s) from this
// unit's blocked_by set.
//
// HOW THE CLAUDE CODE PLUGIN PRECONDITION IS MET, and the PARTIAL CIRCULARITY
// that follows from it: identical to the AP-TC-087 guard, whose header states it
// in full (claude-config-launch-journey.spec.ts). The shipping plugin lives in
// the sibling `roubo-plugins` repo and builds against the published SDK, so an
// agent-kind bundled overlay at e2e/fixtures/bundled-overlays/claude-code/ takes
// the `claude-code` id and mirrors the real manifest. Because that overlay
// implements the argv mapping AND declares the notification wiring itself, this
// guard cannot prove the shipped plugin's own `buildArgs` or its hook carrier;
// both are unit-covered in roubo-plugins. What it does prove is the HOST-side
// integrated path, which nothing else covers end to end: a jig resolving through
// the preset that carries it, reaching the spawned CLI as an argv positional,
// the hook endpoint correlating a POST to that live session, the tab indicator
// appearing and clearing, and PTY exit raising the exited notification.
//
// TWO PLACES THE SHIPPED SURFACE IS NARROWER THAN THE CASE'S WORDING, both
// asserted against what actually ships rather than silently reworded:
//
//   - S001-O01 says the tab reads "Claude 1". The server labels an agent tab
//     `<agentName> <n> - <projectName> #<benchId>` from the plugin manifest's own
//     name (server/services/terminal.ts), so the tab reads "Claude Code 1".
//   - S003-O02 says "the pane shows Waiting for your input". No such affordance
//     ships: the only waiting signal is the tab-level amber dot, and the pane has
//     none at all. Filed as davidpoxon/roubo#1119; this guard asserts the dot.

const PROJECT_ID = "ap-tc-055-jig-session";
// The case's precondition names bench 2, so the fixture seeds two and the
// journey runs on the second.
const BENCH_ID = 2;

/** The jig AP-TC-055 names, bound to the agent whose session it drives. */
const JIG_NAME = "Refactor pass";
const JIG_CONTENT =
  "Refactor pass for bench {{bench.id}}: tighten the module boundaries in this workspace " +
  "and keep the public API unchanged.";
/**
 * The prompt the launch has to carry: the jig's content AS STORED (the writer
 * normalises the markdown body) with its one template resolved, which is what
 * makes this an injection assertion rather than an echo of the literal above.
 * Set in `beforeEach` from the create response.
 */
let expectedPrompt = "";

/** The app-level preset that binds that jig to the agent (AP-FR-008). */
const PRESET_ID = "ap-tc-055-refactor-pass";
const PRESET_NAME = "Refactor pass session";

/**
 * The application-level defaults the precondition's "marked Configured" stands
 * for, and the argv prefix S001-O02 asks for them to assemble into.
 */
const AGENT_CONFIG = { model: "opus", effort: "high", mode: "plan" } as const;
const EXPECTED_FLAGS = ["--model", "opus", "--effort", "high", "--permission-mode", "plan"];

/** The tab label the server actually builds (see the header note on S001-O01). */
const AGENT_TAB_LABEL = `${CLAUDE_AGENT_NAME} 1`;
const SHELL_TAB_LABEL = "Terminal 1";

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  contract: { issue: 507, title: "Agent plugin contract in the SDK + runtime loading" },
  launch: { issue: 510, title: "Core agent launch pipeline: PTY sessions from descriptors" },
  inject: { issue: 512, title: "Jig injection through the agent plugin injection capability" },
  notify: { issue: 513, title: "Agent session notifications: hook-driven waiting/exited" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction:
      "Open the bench Terminal tab and launch the Claude Code preset bound to the Refactor pass jig",
    owners: [SLICE.launch, SLICE.contract],
  },
  S002: {
    id: "S002",
    instruction: "Read the session's opening output",
    owners: [SLICE.inject],
  },
  S003: {
    id: "S003",
    instruction: "Let the agent complete its turn and request user input",
    owners: [SLICE.notify],
  },
  S004: {
    id: "S004",
    instruction: "Select the Claude 1 tab",
    owners: [SLICE.notify],
  },
  S005: {
    id: "S005",
    instruction: "Send a reply, then exit the agent process",
    owners: [SLICE.notify, SLICE.launch],
  },
};

interface TerminalSessionEntry {
  id: string;
  label: string;
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
 * Drop every terminal session on this spec's bench. Live PTY sessions are held
 * in a module-level map keyed by project + bench and are NOT cleared by
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
): Promise<{ live?: TerminalSessionEntry; seen: TerminalSessionEntry[] }> {
  let seen: TerminalSessionEntry[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    seen = await listSessions(request);
    const live = seen.find(
      (session) => session.agentPluginId === CLAUDE_PLUGIN_ID && session.status === "live",
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
        .map(
          (session) => `${session.label}: status=${session.status}, agent=${session.agentPluginId}`,
        )
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
 * Click a target the journey has already TOLERATED a wait for.
 *
 * A bare `click()` on a locator that never appeared blocks until the whole test
 * times out, and a timeout reports nothing: it loses the FR-020 attribution AND
 * takes the per-spec teardown with it, so the next spec inherits this one's
 * app-level presets. The observation that follows each of these clicks is the
 * thing meant to report a missing target, so a missing target is skipped and
 * left to it.
 */
async function clickIfPresent(locator: Locator): Promise<void> {
  if ((await locator.count()) === 1) await locator.click();
}

/** One session tab, located by its short label (the tab bar's own text). */
function sessionTab(page: Page, label: string) {
  // The label span's parent IS the tab: `..` walks to it without depending on
  // any styling class, and the tab carries no test id of its own.
  return page.getByText(label, { exact: true }).locator("..");
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "Claude Code agent plugin is installed and marked Configured".
  // The overlay is discovered under ROUBO_BUNDLED_PLUGINS_DIR and defaults to
  // enabled, but it does have to be CONSENTED (`resolveAgent` refuses an
  // unconsented agent before it hands out a connection) and it has to carry
  // application-level defaults, which is what "Configured" means here and what
  // S001-O02's argv is read against. `clearAgentConfig` first so a previous
  // spec's saved defaults cannot layer underneath (NFR-018).
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);
  await setAgentConfig(request, CLAUDE_PLUGIN_ID, { ...AGENT_CONFIG });

  // Precondition: "Bench 2 is active and its workspace is provisioned". A seeded
  // bench carries a real tmpdir workspace, which is all `isBenchOperable` asks
  // of it, so the journey needs no worktree provisioning and no bench start.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 529,
            integrationId: "github-com",
            externalId: "529",
            title: "First seeded bench, so the journey's bench is bench 2",
          },
        },
        {
          assignedIssue: {
            number: 530,
            integrationId: "github-com",
            externalId: "530",
            title: "Claude session with jig injects prompt and fires the notification hook",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  // Precondition: "A jig bound to Claude Code with initial-prompt injection
  // exists (Refactor pass)", plus the preset that launches it. A project jig
  // lives in the fixture repo's own tmpdir, so the next reset drops it with the
  // project; the preset is app-level and is cleared in afterEach.
  const jig = await createProjectJig(request, PROJECT_ID, {
    name: JIG_NAME,
    description: "Refactor the workspace without changing its public API",
    content: JIG_CONTENT,
    agentPluginId: CLAUDE_PLUGIN_ID,
  });
  expectedPrompt = jig.content.replace("{{bench.id}}", String(BENCH_ID));
  await setAppAgentTools(request, [
    { id: PRESET_ID, name: PRESET_NAME, agent: CLAUDE_PLUGIN_ID, params: {}, jig: jig.id },
  ]);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  await setAppAgentTools(request, []);
  await setDefaultAgent(request, null);
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);
  clearCapturedArgv();
});

test("AP-TC-055: a jig-driven agent session injects its prompt and raises waiting then exited notifications (S001-S005)", async ({
  page,
  request,
}) => {
  // Five steps across two surfaces, two PTY spawns and three notification
  // round-trips, so the default 30s budget is not the thing under test.
  test.setTimeout(180_000);

  await openTerminalTab(page);

  // --- S001: launching the jig-bound preset opens a labelled agent tab -------
  // Unlink first so the argv read below can only be this launch's.
  clearCapturedArgv();
  const menuTrigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await expect(menuTrigger, "the Agent split button offers a launch menu").toBeVisible();
  await menuTrigger.click();
  const presetRow = page.getByRole("menu").getByTestId(`launch-preset-${PRESET_ID}`);
  // A TOLERATED wait, not an assertion: a preset row that never renders leaves
  // the observations below to report the divergence through the FR-020 block
  // rather than failing here as an unattributed Playwright timeout.
  await presetRow.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await clickIfPresent(presetRow);

  const { live, seen } = await waitForLiveAgentSession(request);
  const agentTab = sessionTab(page, AGENT_TAB_LABEL);
  await agentTab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // Counts are read ONCE so the boolean and the reported actual can never
  // disagree.
  const agentTabCount = await agentTab.count();
  observe(
    STEPS.S001,
    "S001-O01",
    live !== undefined && agentTabCount === 1,
    `a PTY session opens (status=live, agentPluginId=${CLAUDE_PLUGIN_ID}) and a new tab labelled "${AGENT_TAB_LABEL}" appears`,
    `session: ${live ? `${live.id} live` : describeSessions(seen)}; tabs labelled "${AGENT_TAB_LABEL}": ${agentTabCount}`,
  );
  const sessionId = live?.id ?? "";

  const argv = await waitForCapturedArgv();
  const captured = argv ?? [];
  // `--session-id <uuid>` is the descriptor's stable argv tail, so everything
  // before it is exactly the generated-flags region the case is about.
  const sessionIdIndex = captured.indexOf("--session-id");
  const generated = sessionIdIndex >= 0 ? captured.slice(0, sessionIdIndex) : captured;
  observe(
    STEPS.S001,
    "S001-O02",
    argv !== null && JSON.stringify(generated) === JSON.stringify(EXPECTED_FLAGS),
    `the launch argv carries the configured model, effort and mode as separate tokens: ${EXPECTED_FLAGS.join(" ")}`,
    argv === null ? "no argv was captured: the child never ran" : JSON.stringify(generated),
  );

  // --- S002: the jig arrives as the session's initial prompt ----------------
  // The child's OWN argv is the evidence, for the same reason AP-TC-087 reads it:
  // no API surfaces a session's prompt, and reconstructing it host-side would
  // assert our own arithmetic rather than what the CLI received.
  const promptIndex = sessionIdIndex >= 0 ? sessionIdIndex + 2 : -1;
  const positional = promptIndex >= 0 ? captured.slice(promptIndex) : [];
  observe(
    STEPS.S002,
    "S002-O01",
    positional.length === 1 && positional[0] === expectedPrompt,
    `the resolved "${JIG_NAME}" jig content is the session's initial prompt: ${JSON.stringify(expectedPrompt)}`,
    positional.length === 0
      ? `no positional after the --session-id tail in ${JSON.stringify(captured)}`
      : JSON.stringify(positional),
  );
  // The prompt reaching argv IS the auto-execution: core only appends a
  // positional when the descriptor declares `initialPrompt.mode:
  // "argv-positional"` AND auto-execute is on. With auto-execute off the same
  // jig is written into the PTY after startup instead, which leaves argv with
  // nothing after the `--session-id` tail, so the two outcomes are distinguishable
  // from the child's own argv alone (AP-FR-018).
  observe(
    STEPS.S002,
    "S002-O02",
    promptIndex >= 0 && captured.length === promptIndex + 1,
    "the prompt auto-executes through the declared argv-positional injection capability, as the single trailing positional",
    `argv=${JSON.stringify(captured)}`,
  );

  // --- S003: the hook fires and the tab shows the amber waiting dot ---------
  // A second tab first. `TerminalTabs` renders the notification indicator only on
  // tabs that are NOT focused, and a launch focuses its own tab, so the waiting
  // dot this step is about is only observable from another tab. That is the same
  // arrangement S004 presumes: it asks for the dot to CLEAR when the agent tab is
  // selected, which can only happen if something else was selected first.
  const shellRes = await request.post(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`, {
    data: {},
  });
  expect(shellRes.status(), "POST terminals (a plain shell tab to hold focus)").toBe(201);
  // Re-open the bench screen so the new session is fetched now rather than on
  // the tab list's own 5s poll: under load that poll is the difference between a
  // second tab and a step with nothing to click.
  await openTerminalTab(page);
  const shellTab = sessionTab(page, SHELL_TAB_LABEL);
  await shellTab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await clickIfPresent(shellTab);

  const hookStatus = await fireWaitingHook(request, sessionId);
  const waiting = await waitForBenchNotification(request, {
    projectId: PROJECT_ID,
    benchId: BENCH_ID,
    type: "agent-waiting",
    sessionId,
  });
  observe(
    STEPS.S003,
    "S003-O01",
    hookStatus === 200 && waiting.found,
    `the notification hook accepts an event correlated to this session id (200) and an agent-waiting notification is raised for session ${sessionId}`,
    `POST /api/hooks/claude-notification -> ${hookStatus}; bench notifications: ${waiting.seen}`,
  );

  const waitingDot = agentTab.getByRole("img", { name: "Action needed" });
  await waitingDot.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const dotCount = await waitingDot.count();
  const dotClass = dotCount === 1 ? ((await waitingDot.getAttribute("class")) ?? "") : "";
  // The case's second half ("the pane shows Waiting for your input") names an
  // affordance that does not ship: see the header note and davidpoxon/roubo#1119.
  // Only the shipped half is asserted here, so this guard reports real drift
  // rather than a permanent red.
  observe(
    STEPS.S003,
    "S003-O02",
    dotCount === 1 && dotClass.includes("bg-amber-500"),
    `the "${AGENT_TAB_LABEL}" tab shows the amber waiting dot (the pane affordance is davidpoxon/roubo#1119)`,
    `waiting indicators on the tab: ${dotCount}${dotCount === 1 ? `, class=${JSON.stringify(dotClass)}` : ""}`,
  );

  // --- S004: selecting the tab clears the waiting indicator -----------------
  await clickIfPresent(agentTab);
  await waitingDot.waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  const clearedDotCount = await waitingDot.count();
  const afterFocus = await waitForNoBenchNotification(request, {
    projectId: PROJECT_ID,
    benchId: BENCH_ID,
    type: "agent-waiting",
    sessionId,
  });
  observe(
    STEPS.S004,
    "S004-O01",
    clearedDotCount === 0 && !afterFocus.found,
    "the waiting indicator on the tab clears once the session is focused, and the notification behind it is dismissed",
    `waiting indicators on the tab: ${clearedDotCount}; bench notifications: ${afterFocus.seen}`,
  );

  // --- S005: a reply, then the agent process exits --------------------------
  // Both are driven over `/ws/terminal/<sessionId>` with the `{type: "input"}`
  // frame the terminal pane itself sends, from the page's own origin. Leaving the
  // bench screen first is what makes the observation deterministic rather than a
  // race: the focused tab auto-dismisses its session's notifications, so an
  // exited notification raised while the agent tab is on screen can be cleared
  // before it is ever read. Navigating away also unmounts the pane's own socket,
  // so this one is uncontested.
  await page.goto("/");
  await page.evaluate(
    async ({ id, frames }) => {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/ws/terminal/${id}`);
        socket.onopen = () => {
          for (const frame of frames) socket.send(JSON.stringify(frame));
          // Give the frames a moment on the wire before the close, which would
          // otherwise drop them.
          setTimeout(() => {
            socket.close();
            resolve();
          }, 500);
        };
        socket.onerror = () => reject(new Error("the terminal socket could not be opened"));
      });
    },
    {
      id: sessionId,
      frames: [
        // The reply, then Ctrl-C: the PTY's line discipline turns 0x03 into SIGINT
        // for the foreground process, which is how a user quits a running agent.
        { type: "input", data: "looks good, ship it\r" },
        { type: "input", data: "\u0003" },
      ],
    },
  );

  const exited = await waitForBenchNotification(request, {
    projectId: PROJECT_ID,
    benchId: BENCH_ID,
    type: "agent-exited",
    sessionId,
  });
  observe(
    STEPS.S005,
    "S005-O01",
    exited.found,
    `an agent-exited notification is raised for session ${sessionId}`,
    `bench notifications: ${exited.seen}`,
  );

  let ended: TerminalSessionEntry | undefined;
  for (let attempt = 0; attempt < 40 && ended === undefined; attempt += 1) {
    ended = (await listSessions(request)).find(
      (session) => session.id === sessionId && session.status === "ended",
    );
    if (ended === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  await openTerminalTab(page);
  const endedTab = sessionTab(page, AGENT_TAB_LABEL);
  await endedTab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // The pane's own exit line, replayed from the session record on reattach, is
  // the user-visible terminated state; the tab's other exit affordance is a
  // muted style, and asserting a Tailwind class string would assert the
  // stylesheet rather than the state.
  const exitLine = page.getByText(/\[Process exited with code \d+\]/).first();
  await exitLine.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const endedTabCount = await endedTab.count();
  const exitLineCount = await exitLine.count();
  observe(
    STEPS.S005,
    "S005-O02",
    ended !== undefined && endedTabCount === 1 && exitLineCount === 1,
    `the "${AGENT_TAB_LABEL}" tab survives the exit and reflects the terminated state (session status=ended, the pane showing its exit line)`,
    `session status=${ended?.status ?? "still live"}, tabs=${endedTabCount}, exit lines=${exitLineCount}`,
  );
});
