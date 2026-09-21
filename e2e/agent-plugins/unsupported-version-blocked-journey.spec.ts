import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CURSOR_AGENT_NAME,
  CURSOR_PLUGIN_ID,
  consentAgent,
  disablePlugin,
  enablePlugin,
  waitForAvailableAgents,
} from "./_support/agent-env.js";
import { CURSOR_BUILDS, clearCursorBuild, setCursorBuild } from "./_support/cursor-version.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "APCC-TC-052".
const observe = makeObserve("APCC-TC-052");

// APCC-TC-052: an unsupported CLI version is caught before a session
// opens.
//
// The integration-level drift guard for the APCC-FR-018 / APCC-US-007 journey.
// It walks the authoritative APCC-TC-052 e2e_flow steps S001-S004 as ordered,
// attributable observations against the REAL built app: the manifest's
// `agentCompatibility` window, the host version probe and its `semver` reading
// of a date build, the verdict served through the agent inventory route, the AI
// Agents card, the pre-launch version gate, the launch route's structured
// refusal, and the bench Terminal tab's blocked-launch panel. On divergence each
// observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice(s).
//
// HOW THE CLI IS "INSTALLED". The `cursor-cli` bundled overlay
// (e2e/fixtures/bundled-overlays/cursor-cli/) mirrors the shipped plugin's
// window (floor 2026.09.08, tested ceiling 2026.09.15) and points both its
// manifest probe and its launch descriptor at `roubo-e2e-cursor-stub`
// (e2e/fixtures/bin/, on the server's PATH). The stub reads a build file on
// every `--version` run (_support/cursor-version.ts), so "install an older CLI"
// and "install a CLI inside the window" are one file write each, with no server
// restart. The gate drops its cached detection when it refuses a launch below
// the floor, so the second launch in S004 probes the stub afresh.
//
// The overlay is force-DISABLED by every /test/__reset (OPT_IN_AGENT_FIXTURE_
// PLUGIN_IDS in server/routes/test.ts), so this spec opts in and hands the
// environment back the way it found it.

const PLUGIN_ID = CURSOR_PLUGIN_ID;
const AGENT_NAME = CURSOR_AGENT_NAME;
const COMMAND = "roubo-e2e-cursor-stub";
const SETTINGS_PATH = "/settings#ai-agents";

/** The overlay's declared floor, which the refusal has to name. */
const FLOOR = "2026.09.08";
/** What `parse: semver` reads out of each stub build. */
const BELOW_VERSION = CURSOR_BUILDS.below.split("-")[0];
const WITHIN_VERSION = CURSOR_BUILDS.within.split("-")[0];

const PROJECT_ID = "apcc-us-007-cursor-journey";
// `/test/__register-fixture-project` writes `seedBenches[i]` with `id: i + 1`.
const BENCH_ID = 1;
const ALL_AGENTS_SECTION = "All agents";

// The slice this unit is blocked by, used by the FR-020 failure-output contract
// to attribute a divergence to an owning slice. There is one: the slice that
// declared the window this journey is gated on, named by requirement and title.
const SLICE = {
  window: { title: "APCC-FR-018: Declare the compatibility window and install locations" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Install a Cursor CLI older than the floor the plugin declares.",
    owners: [SLICE.window],
  },
  S002: {
    id: "S002",
    instruction: "Open the AI Agents settings screen.",
    owners: [SLICE.window],
  },
  S003: {
    id: "S003",
    instruction: "Launch the plugin from a bench Terminal tab.",
    owners: [SLICE.window],
  },
  S004: {
    id: "S004",
    instruction: "Install a CLI inside the supported window and launch again.",
    owners: [SLICE.window],
  },
};

interface Compatibility {
  status?: string;
  detectedVersion?: string;
  cause?: string;
}

interface TerminalSessionEntry {
  id: string;
  status: string;
  command?: string;
  agentPluginId?: string;
}

interface LaunchOutcome {
  status: number;
  body: { launchFailure?: { class?: string; message?: string } } | null;
}

/** The overlay's compatibility verdict, as GET /api/agents reports it. */
async function readCompatibility(request: APIRequestContext): Promise<Compatibility> {
  const res = await request.get("/api/agents");
  if (res.status() !== 200) return {};
  const body = (await res.json()) as { agents: { id: string; compatibility?: Compatibility }[] };
  return body.agents.find((agent) => agent.id === PLUGIN_ID)?.compatibility ?? {};
}

/**
 * Poll until the verdict has resolved, or give up after 15s. The probe behind it
 * is FIRE-AND-FORGET: GET /api/agents starts `warmAgentVersion` and answers from
 * the cache in the same request, so the first reads report `unknown`.
 */
async function waitForCompatibility(request: APIRequestContext): Promise<Compatibility> {
  const unresolved = (status?: string): boolean => status === undefined || status === "unknown";
  let compatibility = await readCompatibility(request);
  for (let attempt = 0; attempt < 60 && unresolved(compatibility.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    compatibility = await readCompatibility(request);
  }
  return compatibility;
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
 * cleared by `/test/__reset`, so a session from an earlier run would read as
 * "a terminal left open" and leave an idling stub behind (NFR-018).
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/** Poll until a live Cursor session exists, or give up after 15s. */
async function waitForLiveSession(
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

function describeSessions(sessions: TerminalSessionEntry[]): string {
  if (sessions.length === 0) return "no terminal sessions on the bench";
  return sessions
    .map((s) => `${s.id}: status=${s.status}, agent=${s.agentPluginId}, command=${s.command}`)
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
 * Open the split button's grouped launch menu and wait for its agent rows. Every
 * wait here is TOLERATED, not an assertion: a menu that never opens leaves the
 * caller's observation to report the divergence through the FR-020 block.
 */
async function openLaunchMenu(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await menu
    .getByTestId("launch-agent-item")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
}

/** The "All agents" row for Cursor CLI, named `<agent name>: <params or blocker>`. */
function allAgentsRow(page: Page): Locator {
  return page
    .getByRole("group", { name: ALL_AGENTS_SECTION })
    .getByRole("menuitem", { name: new RegExp(`^${AGENT_NAME}:`) });
}

/**
 * Run one UI action that launches Cursor CLI, and answer what the launch route
 * reported. Captured rather than inferred from the page, because the route's
 * status and structured `launchFailure` are the host's own account of the gate.
 */
async function captureLaunch(
  page: Page,
  act: () => Promise<boolean>,
): Promise<LaunchOutcome | null> {
  const pending = page
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" && res.url().includes(`/benches/${BENCH_ID}/terminals`),
      { timeout: 30_000 },
    )
    .catch(() => null);
  if (!(await act())) return null;
  const response = await pending;
  if (response === null) return null;
  return {
    status: response.status(),
    body: (await response.json().catch(() => null)) as LaunchOutcome["body"],
  };
}

function describeLaunch(outcome: LaunchOutcome | null): string {
  if (outcome === null) return "no launch request reached the server";
  const failure = outcome.body?.launchFailure;
  return failure
    ? `HTTP ${outcome.status}, launchFailure.class=${failure.class}, message="${failure.message}"`
    : `HTTP ${outcome.status}, no launchFailure`;
}

test.beforeEach(async ({ request }) => {
  // Two launches, two version probes and a settings screen do not fit the
  // config's 30s per-test default on a cold server.
  test.setTimeout(90_000);

  await destroyAllSessions(request);
  // The build file lives in the OS temp dir, so a run killed before afterEach
  // would leave it behind. Start from the stub's in-window default.
  clearCursorBuild();

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 1,
            integrationId: "github-com",
            externalId: "1",
            title: "APCC-TC-052 fixture bench",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, PLUGIN_ID);
  clearCursorBuild();
});

test(
  "APCC-TC-052: an unsupported CLI version is caught before a session opens (S001-S004)",
  { tag: "@APCC-TC-052" },
  async ({ page, request }) => {
    // --- S001: install a Cursor CLI older than the declared floor -------------
    // Written BEFORE the plugin is enabled, so the very first probe (the one the
    // enable's warm starts) already reads the old build.
    setCursorBuild("below");
    // `resolveAgent` refuses an unconsented agent before it hands out a
    // connection, so without consent the card would read unavailable and the
    // launch would 403.
    await enablePlugin(request, PLUGIN_ID);
    await consentAgent(request, PLUGIN_ID);
    await waitForAvailableAgents(request, [PLUGIN_ID]);

    const installed = await waitForCompatibility(request);
    observe(
      STEPS.S001,
      "S001-O01",
      installed.detectedVersion !== undefined && installed.cause !== "command-not-found",
      `The CLI is on the search path: the host resolves "${COMMAND}" and detects a version`,
      `status=${installed.status}, detectedVersion=${installed.detectedVersion ?? "none"}, cause=${installed.cause ?? "none"}`,
    );

    // --- S002: the AI Agents screen shows the version and the floor verdict ---
    await page.goto(SETTINGS_PATH);
    const line = page.getByTestId(`agent-compatibility-${PLUGIN_ID}`);
    await expect(line)
      .toContainText(`${BELOW_VERSION} detected`, { timeout: 15_000 })
      .catch(() => {});
    const lineText = (await line.textContent().catch(() => null)) ?? "";
    const lineStatus = await line.getAttribute("data-status").catch(() => null);

    observe(
      STEPS.S002,
      "S002-O01",
      lineText.includes(`${BELOW_VERSION} detected`),
      `The screen shows the detected version: "${BELOW_VERSION} detected" on the ${AGENT_NAME} card`,
      lineText === "" ? "no compatibility line on the card" : `"${lineText}"`,
    );
    observe(
      STEPS.S002,
      "S002-O02",
      lineStatus === "below-floor" && lineText.includes("below required floor"),
      `The screen reports that the version is below the supported floor: data-status="below-floor" and the "below required floor" chip`,
      `data-status="${lineStatus}", text="${lineText}"`,
    );

    // --- S003: a launch from the bench Terminal tab is blocked ----------------
    await openTerminalTab(page);
    const blocked = await captureLaunch(page, async () => {
      await openLaunchMenu(page);
      const row = allAgentsRow(page);
      await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
      if ((await row.count()) === 0) return false;
      await row.click();
      return true;
    });

    const panel = page.getByTestId("agent-launch-failure");
    await panel.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const panelVisible = await panel.isVisible().catch(() => false);
    const panelClass = await panel.getAttribute("data-failure-class").catch(() => null);
    const panelText = panelVisible ? ((await panel.textContent()) ?? "") : "";

    observe(
      STEPS.S003,
      "S003-O01",
      blocked?.status === 409 &&
        blocked.body?.launchFailure?.class === "below-floor-version" &&
        panelVisible &&
        panelClass === "below-floor-version",
      `The launch is blocked: the launch route answers 409 with a "below-floor-version" launchFailure, and the Terminal tab shows the blocked-launch panel`,
      `${describeLaunch(blocked)}; panel ${panelVisible ? `visible (data-failure-class="${panelClass}")` : "not shown"}`,
    );
    observe(
      STEPS.S003,
      "S003-O02",
      panelText.includes(FLOOR),
      `The message names the version required: "${FLOOR}"`,
      panelVisible ? `"${panelText}"` : "no blocked-launch panel to read",
    );

    const afterBlock = await listSessions(request);
    const agentTab = page.getByText(`${AGENT_NAME} 1`, { exact: true });
    const agentTabCount = await agentTab.count();
    const emptyState = await page
      .getByText("No terminal sessions", { exact: true })
      .isVisible()
      .catch(() => false);
    observe(
      STEPS.S003,
      "S003-O03",
      afterBlock.length === 0 && agentTabCount === 0 && emptyState,
      'No terminal is left open: the bench has no sessions, no Cursor CLI tab, and the Terminal tab reads "No terminal sessions"',
      `${describeSessions(afterBlock)}; ${agentTabCount} "${AGENT_NAME} 1" tab(s); empty state ${emptyState ? "shown" : "not shown"}`,
    );

    // --- S004: install a CLI inside the window and launch again ---------------
    setCursorBuild("within");
    const retry = page.getByTestId("agent-launch-failure-retry");
    const started = await captureLaunch(page, async () => {
      if (!(await retry.isVisible().catch(() => false))) return false;
      await retry.click();
      return true;
    });

    await agentTab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const { live, seen } = await waitForLiveSession(request);
    const tabShown = await agentTab.isVisible().catch(() => false);
    const panelGone = !(await panel.isVisible().catch(() => false));
    const settled = await readCompatibility(request);

    observe(
      STEPS.S004,
      "S004-O01",
      started?.status === 201 &&
        live !== undefined &&
        live.command === COMMAND &&
        tabShown &&
        panelGone,
      `The session starts: the launch route answers 201, a live session runs "${COMMAND}", the "${AGENT_NAME} 1" tab opens and the blocked-launch panel is gone (detected ${WITHIN_VERSION})`,
      `${describeLaunch(started)}; ${live === undefined ? describeSessions(seen) : `${live.id}: status=${live.status}, command=${live.command}`}; tab ${tabShown ? "shown" : "not shown"}; panel ${panelGone ? "gone" : "still shown"}; detected ${settled.detectedVersion ?? "none"} (${settled.status})`,
    );
  },
);
