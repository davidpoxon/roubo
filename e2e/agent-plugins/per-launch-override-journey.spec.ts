import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  readAgentConfig,
  readProjectAgents,
  setAgentConfig,
  setDefaultAgent,
  setProjectAgentOverride,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-028".
const observe = makeObserve("AP-TC-028");

// AP-TC-028 (#529, AP-WU-028) - E2E: the per-launch override dialog applies its
// draft to one session and persists nothing.
//
// The integration-level drift guard for the AP-US-006 journey (AP-FR-010),
// spanning the slices this unit is blocked by (#518, #524). It walks the
// authoritative AP-TC-028 e2e_flow steps S001-S005 as ordered, attributable
// observations against the REAL built app. On divergence each observation routes
// through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice issue(s).
//
// The `claude-code` bundled overlay and the `roubo-e2e-claude-stub` binary are
// the same fixtures the AP-TC-087 guard uses, and its header carries the full
// account of why they exist and what they can and cannot prove. In short: the
// overlay owns the argv mapping, so this guard proves the HOST-side path, which
// here is the whole point of the case. What layer a value came from is exactly
// what is under test.
//
// WHAT "PERSISTS NOTHING" IS PROVED WITH. S004 is a negative, and a negative
// read off one surface is weak evidence: a screen can be stale rather than
// unchanged. So it is proved twice over, from two independent channels. The
// case's own instruction (reopen Settings and the project overrides screen) is
// followed literally, AND the two persisted records are read back through the
// real routes. A per-launch value that leaked into either store would move one
// or the other, and a UI that merely failed to refresh would move only one.
//
// WHY THE ARGV IS READ FROM THE CHILD. S003 asks whether the one-off overrides
// reached the session, not whether the request carried them. The spawned stub
// writes its own `process.argv.slice(2)` to AGENT_ARGV_LOG_PATH, so the assertion
// is over what the CLI actually received rather than a host-side reconstruction
// of our own layer arithmetic.

const PROJECT_ID = "ap-tc-028-launch-overrides";
const BENCH_ID = 1;

/** Precondition: "app defaults opus - high - plan". */
const APP_DEFAULTS = { model: "opus", effort: "high", mode: "plan" } as const;

/** Precondition: "The project overrides model to sonnet". */
const PROJECT_OVERRIDES = { model: "sonnet" } as const;

/** The one-off draft S002 sets, by config key and by rendered option label. */
const ONE_OFF = {
  model: { value: "opus", label: "Opus" },
  effort: { value: "xhigh", label: "Extra high" },
  mode: { value: "auto", label: "Auto" },
} as const;

/**
 * The argv the one-off draft must assemble into. Everything before the
 * descriptor's `--session-id <uuid>` tail is the generated-flags region, and
 * mode=auto reaching it as `--permission-mode auto` is S003-O01's "(mode=auto)
 * applied".
 */
const EXPECTED_ARGV_PREFIX = [
  "--model",
  ONE_OFF.model.value,
  "--effort",
  ONE_OFF.effort.value,
  "--permission-mode",
  ONE_OFF.mode.value,
];

/**
 * The trace with the one-off draft on top (S002-O01). App `model` is superseded
 * by the project layer AND by this launch, app `effort`/`mode` by this launch,
 * and the project's `model` by this launch, so every lower entry is struck
 * through and only the top layer survives.
 */
const EXPECTED_ONE_OFF_TRACE =
  "app: model=opus (superseded) effort=high (superseded) mode=plan (superseded)" +
  " -> project: model=sonnet (superseded)" +
  " -> perLaunch: model=opus effort=xhigh mode=auto";

/**
 * The trace with nothing drafted: the saved defaults alone (S005-O01). Only the
 * project's `model` supersedes anything, and the top layer contributes nothing,
 * which is what makes this string the discriminating opposite of the one above.
 */
const EXPECTED_BASELINE_TRACE =
  "app: model=opus (superseded) effort=high mode=plan" +
  " -> project: model=sonnet" +
  " -> perLaunch: nothing";

/** The dialog's caption, verbatim from S001-O01. */
const ONE_SESSION_CAPTION = "One session only. Nothing is saved.";

/**
 * The toast an overridden launch raises (`TerminalTabs.tsx`), verbatim from
 * S003-O02: it both confirms the session started and says the launch carried
 * one-off overrides. A launch with no draft still raises the plain
 * `<agent> session started`, which is what AP-TC-017 S001-O03 asserts.
 */
const LAUNCH_TOAST = `${CLAUDE_AGENT_NAME} session started with overrides`;

/**
 * What the toast poll looks for: the prefix BOTH branches share, never the full
 * expected string. Polling for the full string would make a regressed toast
 * (the plain `<agent> session started`) invisible to the poll, so S003-O02 would
 * report "no toast appeared" for one that plainly did, and the expected-vs-actual
 * the failure-output contract promises would name the wrong failure. The needle
 * finds any launch toast; the exact comparison below decides whether it is the
 * right one.
 */
const LAUNCH_TOAST_PREFIX = `${CLAUDE_AGENT_NAME} session started`;

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  dialog: { issue: 518, title: "Per-launch override dialog with resolution trace" },
  a11y: { issue: 524, title: "Accessibility audit of the agent surfaces (WCAG 2.1 AA)" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the launch menu and click 'Launch with overrides...'",
    owners: [SLICE.dialog, SLICE.a11y],
  },
  S002: {
    id: "S002",
    instruction:
      "Set Agent Claude Code, Model opus, Effort xhigh, Mode auto and read the Resolution trace",
    owners: [SLICE.dialog],
  },
  S003: {
    id: "S003",
    instruction: "Click 'Launch session'",
    owners: [SLICE.dialog],
  },
  S004: {
    id: "S004",
    instruction: "Reopen Settings (agent defaults) and the project overrides screen",
    owners: [SLICE.dialog],
  },
  S005: {
    id: "S005",
    instruction: "Reopen the override dialog",
    owners: [SLICE.dialog],
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
 * Open the split button's grouped launch menu and press "Launch with
 * overrides...", returning the dialog locator.
 *
 * The tab bar and the empty state each render one chevron, so the trigger is
 * taken `.first()` exactly as `launch-menu-presets.spec.ts` takes it. Every wait
 * here is TOLERATED rather than asserted: a menu or dialog that never appears is
 * reported by the caller's observation through the FR-020 block, not as an
 * unattributed Playwright timeout.
 *
 * Both clicks carry an EXPLICIT timeout. `actionTimeout` is unset in
 * playwright.config.ts, so its default of 0 means no limit, and a click on a
 * locator that never appears would block until the whole test timed out. That is
 * exactly the divergence the tolerated waits above exist to report, so an
 * unbounded click here would swallow the FR-020 block this helper promises.
 */
async function openOverridesDialog(page: Page): Promise<Locator> {
  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await trigger.click({ timeout: 5_000 }).catch(() => {});
  const action = page.getByRole("menuitem", { name: "Launch with overrides" });
  await action.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await action.click({ timeout: 5_000 }).catch(() => {});
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  return dialog;
}

/**
 * The rendered Resolution trace, normalised to one comparable string.
 *
 * Composed from the per-layer and per-entry testids rather than matched against
 * the case's prose, because the panel renders a line per layer (with the arrow
 * as a separate glyph) and marks a beaten value with `data-superseded` and a
 * strike-through rather than by removing it. Reading the flag back is the only
 * way to say WHICH layer a value actually resolves from, which is the whole
 * claim S002-O01 and S005-O01 make.
 */
async function readResolutionTrace(dialog: Locator): Promise<string> {
  const parts: string[] = [];
  for (const layerId of ["app", "project", "preset", "perLaunch"]) {
    const line = dialog.getByTestId(`resolution-layer-${layerId}`);
    if ((await line.count()) !== 1) continue;
    const entries = line.locator("[data-superseded]");
    const count = await entries.count();
    if (count === 0) {
      parts.push(`${layerId}: nothing`);
      continue;
    }
    const rendered: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = entries.nth(index);
      const text = ((await entry.textContent()) ?? "").trim();
      const superseded = (await entry.getAttribute("data-superseded")) === "true";
      rendered.push(superseded ? `${text} (superseded)` : text);
    }
    parts.push(`${layerId}: ${rendered.join(" ")}`);
  }
  return parts.join(" -> ");
}

/**
 * One element's trimmed text, or the literal `<not rendered>` when it is absent.
 *
 * `locator.textContent()` auto-waits, and `actionTimeout` is unset in
 * playwright.config.ts (default 0, no limit), so reading a surface that never
 * rendered would block until the test budget expired rather than reaching the
 * observation that is supposed to report it. Deciding on `count()` first takes
 * the read only when there is something to read, which is how the sibling guard
 * keeps a missing element from bypassing the observer from inside its own
 * argument list (claude-config-launch-journey.spec.ts S006).
 */
async function readTextIfPresent(locator: Locator): Promise<string> {
  if ((await locator.count()) !== 1) return "<not rendered>";
  return ((await locator.textContent()) ?? "").trim();
}

/**
 * The launch toast's text, caught while it is still on screen.
 *
 * Toasts self-dismiss after 3s (`ToastProvider`), so a wait-then-read would race
 * the timer on a slow launch and report "no toast" for one that did appear.
 * Polling and keeping the FIRST sighting takes the read and the sighting in the
 * same tick. `null` means it never appeared inside the window.
 */
async function captureToast(page: Page, contains: string): Promise<string | null> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const texts = await page.getByRole("status").allTextContents();
    const hit = texts.map((text) => text.trim()).find((text) => text.includes(contains));
    if (hit !== undefined) return hit;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "Claude Code is the default agent". The overlay is discovered
  // under ROUBO_BUNDLED_PLUGINS_DIR and defaults to enabled, but it must be
  // CONSENTED: `resolveAgent` refuses an unconsented agent before it ever hands
  // out a connection, so without this the launch menu would offer nothing.
  //
  // The second overlay (`codex-cli`) is deliberately left disabled, as the case's
  // preconditions name only Claude Code. That leaves `resolveLaunchAgentId`'s
  // lone-available-agent fallback reachable, so the pin below is set explicitly
  // rather than leant on.
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);

  // Precondition: "app defaults opus - high - plan". Written through the same
  // route the AI Agents card's Save defaults button uses, because the record
  // lives in `~/.roubo-dev/<checkout>/agents/_global/` and is NOT among the files
  // `/test/__reset` truncates: whatever an earlier spec left there would
  // otherwise be this spec's app layer (NFR-018).
  await setAgentConfig(request, CLAUDE_PLUGIN_ID, APP_DEFAULTS);

  // Precondition: "Bench 2 Terminal tab is open". A seeded bench carries a real
  // tmpdir workspace, which is all `isBenchOperable` asks of it, so the journey
  // needs no worktree provisioning and no bench start. Which bench index it is
  // carries nothing: the case's own layers are app and project scoped.
  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 529,
            integrationId: "github-com",
            externalId: "529",
            title: "Launch one session with per-launch overrides",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  // Precondition: "The project overrides model to sonnet". After registration,
  // because the route 404s on a project the registry has never heard of.
  await setProjectAgentOverride(request, PROJECT_ID, CLAUDE_PLUGIN_ID, PROJECT_OVERRIDES);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // Both stores outlive `/test/__reset`, and this is the first spec here to
  // leave non-empty app defaults behind, so handing them back is what keeps the
  // AP-TC-087 guard's own "clear then edit" precondition true when it runs after
  // this file (NFR-018).
  await setProjectAgentOverride(request, PROJECT_ID, CLAUDE_PLUGIN_ID, {});
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);
  await setDefaultAgent(request, null);
  clearCapturedArgv();
});

// Every tolerated wait in this guard is time an observation is allowed to take
// before it reports a divergence, and on a failing run they add up well past the
// 30s default: `openOverridesDialog` alone may spend 45s, and it is called
// twice, with a further 35s on the S003 failure path. A budget that expired
// mid-step would abort the test before `observe` ran, replacing the FR-020
// attribution block with a bare timeout. The happy path is unaffected: the whole
// journey runs in a second or two.
test.setTimeout(180_000);

test("AP-TC-028: a per-launch override applies to one session and persists nothing (S001-S005)", async ({
  page,
  request,
}) => {
  await openTerminalTab(page);

  // --- S001: the override dialog opens, saying what it is for ----------------
  const dialog = await openOverridesDialog(page);
  const dialogCount = await dialog.count();
  const caption = dialog.getByText(ONE_SESSION_CAPTION, { exact: true });
  const captionCount = dialogCount === 1 ? await caption.count() : 0;
  observe(
    STEPS.S001,
    "S001-O01",
    dialogCount === 1 && captionCount === 1,
    `the per-launch override dialog opens showing "${ONE_SESSION_CAPTION}"`,
    `dialogs=${dialogCount}, captions matching verbatim=${captionCount}`,
  );

  // --- S002: draft the one-off values and read the Resolution trace ----------
  // Agent first: switching agent re-bases the draft against the newly selected
  // agent's schema, so setting it after the params would discard them.
  await dialog.locator("#launch-overrides-agent").selectOption(CLAUDE_PLUGIN_ID);
  for (const [key, choice] of Object.entries(ONE_OFF)) {
    await dialog.locator(`#launch-overrides-${key}`).selectOption(choice.value);
  }

  const oneOffTrace = await readResolutionTrace(dialog);
  observe(
    STEPS.S002,
    "S002-O01",
    oneOffTrace === EXPECTED_ONE_OFF_TRACE,
    `the Resolution trace reads ${EXPECTED_ONE_OFF_TRACE}`,
    oneOffTrace.length === 0 ? "no resolution trace rendered" : oneOffTrace,
  );

  // --- S003: launching applies the draft to THIS session ---------------------
  // Unlink first so the argv read below can only be this launch's.
  clearCapturedArgv();
  await dialog.getByRole("button", { name: "Launch session" }).click();

  // The toast is read before the session poll because it self-dismisses; the
  // observation for it is still emitted in step order, below.
  const toast = await captureToast(page, LAUNCH_TOAST_PREFIX);
  const { live, seen } = await waitForLiveAgentSession(request, CLAUDE_PLUGIN_ID);
  const argv = await waitForCapturedArgv();
  const captured = argv ?? [];
  // `--session-id <uuid>` is the descriptor's stable argv tail, so everything
  // before it is exactly the region the resolved layers assemble into.
  const sessionIdIndex = captured.indexOf("--session-id");
  const generated = sessionIdIndex >= 0 ? captured.slice(0, sessionIdIndex) : captured;
  observe(
    STEPS.S003,
    "S003-O01",
    live !== undefined &&
      argv !== null &&
      sessionIdIndex >= 0 &&
      JSON.stringify(generated) === JSON.stringify(EXPECTED_ARGV_PREFIX),
    `a live ${CLAUDE_AGENT_NAME} session opens whose argv carries the one-off overrides, mode=auto included: ${EXPECTED_ARGV_PREFIX.join(" ")}`,
    `session: ${live ? `${live.id} live agent=${live.agentPluginId}` : describeSessions(seen)}; argv: ${
      argv === null ? "never captured, the child did not run" : JSON.stringify(captured)
    }`,
  );

  // S003-O02 asserts both halves the case names: that a toast confirms the
  // session started, and that it says the launch carried overrides. The toast
  // once said only the former; #690's precedent (see launch-menu-presets.spec.ts)
  // is that a case-vs-copy divergence is settled in favour of the case, so
  // `TerminalTabs` now appends the suffix whenever a launch carries a non-empty
  // per-launch draft.
  observe(
    STEPS.S003,
    "S003-O02",
    toast === LAUNCH_TOAST,
    `a toast confirms the session started with overrides, naming the agent: "${LAUNCH_TOAST}"`,
    toast === null ? "no toast appeared within 15s of the launch" : JSON.stringify(toast),
  );

  // --- S004: neither store moved --------------------------------------------
  // Followed literally first: the two screens the case names, reopened.
  const settingsRes = await page.goto("/settings#ai-agents");
  expect(settingsRes?.status(), "GET /settings").toBe(200);
  const agentsTab = page.getByRole("tab", { name: "AI Agents" });
  await expect(agentsTab, "the AI Agents settings tab renders").toBeVisible();
  await agentsTab.click();

  const modelField = page.getByTestId("config-field-model");
  await modelField.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const shown = {
    model: await readTextIfPresent(modelField),
    effort: await readTextIfPresent(page.getByTestId("config-field-effort")),
    mode: await readTextIfPresent(page.getByTestId("config-field-mode")),
  };
  observe(
    STEPS.S004,
    "S004-O01",
    shown.model.includes("Opus") && shown.effort.includes("High") && shown.mode.includes("Plan"),
    "the AI Agents screen still shows the saved app defaults Opus / High / Plan",
    JSON.stringify(shown),
  );

  const projectSettingsRes = await page.goto(`/projects/${PROJECT_ID}/settings`);
  expect(projectSettingsRes?.status(), "GET the project settings page").toBe(200);
  const effectiveLine = page.getByTestId(`project-agent-effective-${CLAUDE_PLUGIN_ID}`);
  await effectiveLine.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const effectiveText = await readTextIfPresent(effectiveLine);
  // effort and mode still reading "Inherits app default" is the visible half of
  // "none of the per-launch overrides were written": had xhigh or auto landed
  // here, both rows would have flipped to overridden.
  const inheritedRows = {
    effort: await page.getByTestId(`project-agent-inherits-${CLAUDE_PLUGIN_ID}-effort`).count(),
    mode: await page.getByTestId(`project-agent-inherits-${CLAUDE_PLUGIN_ID}-mode`).count(),
  };
  observe(
    STEPS.S004,
    "S004-O01",
    effectiveText.includes("model=sonnet") &&
      effectiveText.includes("effort=high") &&
      effectiveText.includes("mode=plan") &&
      inheritedRows.effort === 1 &&
      inheritedRows.mode === 1,
    "the project overrides screen still overrides model only, resolving to model=sonnet, effort=high, mode=plan with effort and mode inheriting",
    `effective line=${JSON.stringify(effectiveText)}, inheriting rows=${JSON.stringify(inheritedRows)}`,
  );

  // Then proved independently of the screens, off the persisted records. A stale
  // render and an unchanged store are different things, and only this half can
  // tell them apart.
  const persistedAppDefaults = await readAgentConfig(request, CLAUDE_PLUGIN_ID);
  observe(
    STEPS.S004,
    "S004-O01",
    JSON.stringify(persistedAppDefaults) === JSON.stringify(APP_DEFAULTS),
    `the persisted app defaults are still ${JSON.stringify(APP_DEFAULTS)}, with no per-launch value written`,
    JSON.stringify(persistedAppDefaults),
  );

  const projectAgents = await readProjectAgents(request, PROJECT_ID);
  const claude = projectAgents.find((agent) => agent.id === CLAUDE_PLUGIN_ID);
  observe(
    STEPS.S004,
    "S004-O01",
    claude !== undefined &&
      JSON.stringify(claude.overrides ?? {}) === JSON.stringify(PROJECT_OVERRIDES),
    `the persisted project override is still ${JSON.stringify(PROJECT_OVERRIDES)}, with no effort or mode key added`,
    claude === undefined
      ? `no ${CLAUDE_PLUGIN_ID} entry in ${JSON.stringify(projectAgents.map((agent) => agent.id))}`
      : JSON.stringify(claude.overrides ?? {}),
  );

  // --- S005: a reopened dialog starts from the saved defaults ----------------
  await openTerminalTab(page);
  const reopened = await openOverridesDialog(page);
  const reopenedValues: Record<string, string> = {};
  for (const key of Object.keys(ONE_OFF)) {
    const field = reopened.locator(`#launch-overrides-${key}`);
    reopenedValues[key] = (await field.count()) === 1 ? await field.inputValue() : "<not rendered>";
  }
  // The empty value IS "inherit" (`INHERIT` in settings/agents/agent-params.ts):
  // a field left there is absent from the draft and keeps resolving from the
  // layers beneath it.
  observe(
    STEPS.S005,
    "S005-O01",
    Object.values(reopenedValues).every((value) => value === ""),
    "every parameter field is back on inherit, carrying none of the previous one-off values",
    JSON.stringify(reopenedValues),
  );

  const reopenedTrace = await readResolutionTrace(reopened);
  observe(
    STEPS.S005,
    "S005-O01",
    reopenedTrace === EXPECTED_BASELINE_TRACE,
    `the Resolution trace reads the unchanged saved defaults, ${EXPECTED_BASELINE_TRACE}`,
    reopenedTrace.length === 0 ? "no resolution trace rendered" : reopenedTrace,
  );
});
