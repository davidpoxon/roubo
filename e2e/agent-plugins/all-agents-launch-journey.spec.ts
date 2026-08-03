import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  CODEX_AGENT_NAME,
  CODEX_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  disablePlugin,
  enablePlugin,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-022".
const observe = makeObserve("AP-TC-022");

// AP-TC-022 (#527, AP-WU-026) - E2E: launch any configured agent from the
// Terminal tab's "All agents" menu section.
//
// The integration-level drift guard for the AP-US-004 journey (AP-FR-007,
// AP-FR-011), spanning the slices this unit covers (#502, #510, #517, #524). It
// walks the authoritative AP-TC-022 e2e_flow steps S001-S003 as ordered,
// attributable observations against the REAL built app. On divergence each
// observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s).
//
// WHAT MAKES THIS CASE DIFFERENT from its sibling guard in
// launch-menu-presets.spec.ts, which shares almost all of this scaffolding: this
// one launches from the "All agents" section rather than from a preset section,
// it launches TWO agents in sequence, and its precondition pins Bench 2, so the
// fixture project is registered with two seeded benches.
//
// WHY A BROWSER, not jsdom. The case is about a menu that only exists once a
// project, a bench and a resolved agent inventory are all real, and it ends in
// two live PTY sessions. AgentLaunchMenu's unit tests can prove the grouping
// given a props array; only this can prove that two installed agent plugins each
// travel from a menu row through the launch pipeline into a spawned child, and
// that the tab bar then holds both.
//
// EVIDENCE IS ASYMMETRIC BETWEEN THE TWO LAUNCHES, deliberately. Claude Code's
// launch is proved from the child's OWN `process.argv`: `roubo-e2e-claude-stub`
// writes it to AGENT_ARGV_LOG_PATH, so "its PTY runs the claude CLI" is the
// child's own report rather than a host-side reconstruction. Codex CLI's launch
// cannot use that channel: `roubo-e2e-codex-stub` never writes the argv log on
// purpose, because the log is a single shared file the AP-TC-087 guard reads as
// evidence of its own launch and a second writer could only race it. So S003-O01
// is proved from the session record instead (`agentPluginId` plus the
// `TerminalSession.command` the descriptor named), read back through the real
// terminals route. That is weaker than the Claude half by design, not by
// oversight.

const PROJECT_ID = "ap-tc-022-all-agents";
// "Bench 2 Terminal tab is open" (precondition). `/test/__register-fixture-project`
// writes `seedBenches[i]` with `id: i + 1`, so two seeded benches is what makes
// bench 2 exist.
const BENCH_ID = 2;

const BUILTIN_SECTION = "Built-in · default agent";
const AGENT_TOOLS_SECTION = "Agent tools";
const ALL_AGENTS_SECTION = "All agents";

/** The command the `codex-cli` overlay's launch descriptor names. */
const CODEX_COMMAND = "roubo-e2e-codex-stub";

// The slice issues this unit covers, used by the FR-020 failure-output contract
// to attribute a divergence.
const SLICE = {
  contract: { issue: 502, title: "Spike: agent-contract shape against Claude Code and Codex" },
  pipeline: { issue: 510, title: "Core agent launch pipeline: PTY sessions from descriptors" },
  menu: { issue: 517, title: "Terminal tab agent launch UX: split-button and grouped launch menu" },
  a11y: { issue: 524, title: "Accessibility audit of the agent surfaces (WCAG 2.1 AA)" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Click the chevron segment of the Agent split-button to open the launch menu",
    owners: [SLICE.menu, SLICE.a11y],
  },
  S002: {
    id: "S002",
    instruction: "Under 'All agents', click Claude Code",
    owners: [SLICE.menu, SLICE.pipeline, SLICE.contract],
  },
  S003: {
    id: "S003",
    instruction: "Reopen the launch menu and under 'All agents', click Codex CLI",
    owners: [SLICE.menu, SLICE.pipeline, SLICE.contract],
  },
};

interface TerminalSessionEntry {
  id: string;
  label: string;
  status: string;
  command?: string;
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
        .map(
          (session) =>
            `${session.id}: status=${session.status}, agent=${session.agentPluginId}, command=${session.command}`,
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
 * Open the split button's grouped launch menu. With no sessions open the tab bar
 * and the empty state each render one chevron, so there are two identical
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
  // The menu is data-INDEPENDENT: all three MenuSections render before
  // `useAgentPresets` and the agent inventory resolve, and the chevron that
  // opens it is never disabled. So waiting on the menu alone would let the rows
  // below be read against an empty "All agents" list. Wait for the first agent
  // row too, also TOLERATED for the same reason.
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  return menu;
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
 * The rendered tab-bar text of every agent session tab, once `count` of them are
 * present (or after 15s). The tab bar renders each session as a plain div with
 * no ARIA tab role, so an agent tab is identified by the `session-agent-icon`
 * only agent sessions render, and its label is read from the enclosing div.
 * #524 audited these surfaces and left the tab bar without tab semantics, so
 * this structural read is current intended state, not a regression.
 */
async function readAgentTabLabels(page: Page, count: number): Promise<string[]> {
  const icons = page.getByTestId("session-agent-icon");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await icons.count()) >= count) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const labels: string[] = [];
  const seen = await icons.count();
  for (let i = 0; i < seen; i += 1) {
    labels.push(((await icons.nth(i).locator("xpath=..").textContent()) ?? "").trim());
  }
  return labels;
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "Claude Code and Codex CLI are both installed and configured".
  // The codex-cli overlay is force-disabled by every /test/__reset
  // (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS), so it has to be enabled here and handed
  // back disabled in afterEach.
  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID]);
  // Pinned explicitly rather than left to the lone-available-agent fallback,
  // which this spec removes for itself by installing a second agent. The
  // built-in section's header names the default agent, so S001 needs one.
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
  // Application-level defaults saved by another spec would layer under both
  // launches and change the argv S002 reads.
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);
  await clearAgentConfig(request, CODEX_PLUGIN_ID);

  // Two seeded benches, so the case's "Bench 2" precondition is met literally.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 526,
            integrationId: "github-com",
            externalId: "526",
            title: "A first bench, so the bench under test is the second",
          },
        },
        {
          assignedIssue: {
            number: 527,
            integrationId: "github-com",
            externalId: "527",
            title: "Launch any configured agent from the Terminal tab All-agents menu",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  await setDefaultAgent(request, null);
  // Hand the environment back with exactly one available agent again: the second
  // overlay is opt-in per spec, and AP-TC-087's single-available-agent fallback
  // depends on it being off (NFR-018).
  await disablePlugin(request, CODEX_PLUGIN_ID);
  clearCapturedArgv();
});

test("AP-TC-022: both installed agents launch from the All agents section as distinct tabs (S001-S003)", async ({
  page,
  request,
}) => {
  await openTerminalTab(page);

  // --- S001: the menu opens with all three sections -------------------------
  await openLaunchMenu(page);

  // Counts are read ONCE so the boolean and the reported actual cannot disagree.
  const builtinCount = await page.getByRole("group", { name: BUILTIN_SECTION }).count();
  const agentToolsCount = await page.getByRole("group", { name: AGENT_TOOLS_SECTION }).count();
  const allAgentsCount = await page.getByRole("group", { name: ALL_AGENTS_SECTION }).count();
  observe(
    STEPS.S001,
    "S001-O01",
    builtinCount === 1 && agentToolsCount === 1 && allAgentsCount === 1,
    `the launch menu opens with one section each named "${BUILTIN_SECTION}", "${AGENT_TOOLS_SECTION}" and "${ALL_AGENTS_SECTION}"`,
    `sections found: "${BUILTIN_SECTION}"=${builtinCount}, "${AGENT_TOOLS_SECTION}"=${agentToolsCount}, "${ALL_AGENTS_SECTION}"=${allAgentsCount}`,
  );

  // --- S002: clicking Claude Code under All agents launches it --------------
  // Unlink first so the argv read below can only be this launch's.
  clearCapturedArgv();
  await allAgentsRow(page, CLAUDE_AGENT_NAME).click();

  const claude = await waitForLiveAgentSession(request, CLAUDE_PLUGIN_ID);
  const argv = await waitForCapturedArgv();
  observe(
    STEPS.S002,
    "S002-O01",
    claude.live !== undefined && argv !== null,
    `a new live ${CLAUDE_AGENT_NAME} session opens (agentPluginId=${CLAUDE_PLUGIN_ID}) whose PTY actually ran the claude CLI, evidenced by the child writing its own argv`,
    `session: ${claude.live ? `${claude.live.id} live agent=${claude.live.agentPluginId} command=${claude.live.command}` : describeSessions(claude.seen)}; argv: ${
      argv === null ? "never captured, the child did not run" : JSON.stringify(argv)
    }`,
  );

  const menuAfterLaunch = page.getByRole("menu");
  // TOLERATED: give the menu a chance to close so a slow unmount is not read as
  // a menu that stayed open. A menu that never closes still reports below.
  await menuAfterLaunch.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  const openMenus = await menuAfterLaunch.count();
  observe(
    STEPS.S002,
    "S002-O02",
    openMenus === 0,
    "the launch menu closes after the launch",
    `menus still rendered after the launch: ${openMenus}`,
  );

  // --- S003: reopening it and clicking Codex CLI launches the second agent ---
  await openLaunchMenu(page);
  await allAgentsRow(page, CODEX_AGENT_NAME).click();

  const codex = await waitForLiveAgentSession(request, CODEX_PLUGIN_ID);
  observe(
    STEPS.S003,
    "S003-O01",
    codex.live !== undefined && codex.live.command === CODEX_COMMAND,
    `a new live ${CODEX_AGENT_NAME} session opens (agentPluginId=${CODEX_PLUGIN_ID}) whose PTY runs the codex CLI the overlay's descriptor names, "${CODEX_COMMAND}"`,
    `session: ${codex.live ? `${codex.live.id} live agent=${codex.live.agentPluginId} command=${codex.live.command}` : describeSessions(codex.seen)}`,
  );

  const tabLabels = await readAgentTabLabels(page, 2);
  const distinct = new Set(tabLabels);
  observe(
    STEPS.S003,
    "S003-O02",
    tabLabels.length === 2 &&
      distinct.size === 2 &&
      tabLabels.some((label) => label.startsWith(CLAUDE_AGENT_NAME)) &&
      tabLabels.some((label) => label.startsWith(CODEX_AGENT_NAME)),
    `the tab bar holds two distinct agent session tabs, one labelled for ${CLAUDE_AGENT_NAME} and one for ${CODEX_AGENT_NAME}`,
    `agent session tabs rendered: ${JSON.stringify(tabLabels)}`,
  );
});
