import fs from "node:fs";
import path from "node:path";
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
  readBenchWorkspacePath,
  seedLegacyAgentSettings,
  setDefaultAgent,
  setDefaultJig,
  setProjectPermissions,
  waitForAvailableAgents,
  waitForBenchNotification,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-102".
const observe = makeObserve("AP-TC-102");

// AP-TC-102 (#530, AP-WU-029) - E2E: an existing user upgrades, sees the
// first-run notice, configures the plugin, and launches with parity intact.
//
// One of the three integration-level drift guards for the AP-US-007 journey
// (AP-FR-018, AP-FR-021). It walks the authoritative AP-TC-102 e2e_flow steps
// S001-S006 as ordered, attributable observations against the REAL built app. On
// divergence each observation routes through the FR-020 failure-output contract
// (see ../component-plugins/_support/step-runner.ts): the failure reports which
// step diverged, the expected-vs-actual, and the owning slice issue(s) from this
// unit's blocked_by set.
//
// HOW THE UPGRADE PRECONDITION IS MET. "The user is upgrading from a build that
// had built-in agent settings" is a state nothing in the product can produce any
// more: #521 deleted the field and left only a reader behind the
// `legacyAgentSettingsPresent` flag the notice is gated on. `POST
// /test/__seed-legacy-agent-settings` (ROUBO_E2E only) plants that residue, and
// the teardown removes it, because `/test/__reset` does not truncate
// `settings.json` and a seeded upgrade would otherwise leak into every later
// spec (NFR-018).
//
// HOW THE CLAUDE CODE PLUGIN PRECONDITION IS MET, and the PARTIAL CIRCULARITY
// that follows: identical to the AP-TC-087 guard, whose header states it in full
// (claude-config-launch-journey.spec.ts). The `claude-code` bundled overlay under
// e2e/fixtures/bundled-overlays/ takes the real plugin's id and mirrors its
// manifest, so the config form renders the real fields and the launch descriptor
// carries the real notification wiring. This guard therefore cannot prove the
// shipped plugin's own mapping; it proves the HOST-side integrated path across
// the upgrade: the notice appearing exactly once, the config form opening on the
// PLUGIN's defaults rather than anything derived from the residue, and a
// jig-driven launch still injecting and still wiring its hook afterwards.
//
// ONE PLACE THE SHIPPED COPY IS NARROWER THAN THE CASE'S WORDING, asserted
// against what ships rather than silently reworded: S001-O02 says the notice
// states that "auto mode, plan mode" were not migrated. The shipped notice says
// "Your previous agent preferences were not carried over" without enumerating
// them, which is deliberate: since #521 no user-facing string in core names a
// specific agent's modes (docs/brand.md). The observation asserts the
// non-migration statement, not the enumeration.

const PROJECT_ID = "ap-tc-102-upgrade-parity";
const BENCH_ID = 1;

/** The residue that makes this install an upgrade: the two retired preferences. */
const LEGACY_AGENT_SETTINGS = { autoMode: true, planMode: true };

/** The jig the post-upgrade launch has to inject exactly as before. */
const JIG_NAME = "Upgrade parity check";
const JIG_CONTENT =
  "Upgrade parity check for bench {{bench.id}}: confirm the workspace still builds.";
/**
 * The prompt the post-upgrade launch has to carry: the jig's content AS STORED
 * (the writer normalises the markdown body) with its one template resolved. Set
 * in `beforeEach` from the create response.
 */
let expectedPrompt = "";

/** "The project permissions" S005-O02 expects to find in the workspace file. */
const PERMISSIONS = { allow: ["Bash(ls:*)"], ask: ["Bash(git push:*)"], deny: ["Bash(rm:*)"] };

/** The plugin's OWN schema defaults, as the overlay's manifest declares them. */
const PLUGIN_DEFAULTS = { model: "Account default", effort: "CLI default", mode: "Default" };

/** What S003 sets, and what the launch in S004 then has to carry. */
const CHOSEN = { model: "opus", effort: "high", mode: "plan" } as const;
const EXPECTED_FLAGS = ["--model", "opus", "--effort", "high", "--permission-mode", "plan"];

const NOTICE_TESTID = "agent-migration-notice";
const SETTINGS_REL_PATH = path.join(".claude", "settings.local.json");
const HOOK_ENDPOINT = "/api/hooks/claude-notification";

// The slice issues this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice.
const SLICE = {
  removal: {
    issue: 521,
    title: "Remove the built-in Claude Code path: first-run notice and core purity guard",
  },
  inject: { issue: 512, title: "Jig injection through the agent plugin injection capability" },
  notify: { issue: 513, title: "Agent session notifications: hook-driven waiting/exited" },
  permissions: {
    issue: 514,
    title: "Generalized agent permissions with per-agent mapping and bench resync",
  },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction:
      "Launch the app for the first time after the upgrade and open the AI Agents screen",
    owners: [SLICE.removal],
  },
  S002: {
    id: "S002",
    instruction: "Open the Claude Code plugin config form",
    owners: [SLICE.removal],
  },
  S003: {
    id: "S003",
    instruction: "Set Model=opus, Effort=high, Mode=plan and click Save defaults",
    owners: [SLICE.removal],
  },
  S004: {
    id: "S004",
    instruction:
      "Open a bench Terminal tab and launch a jig-driven Claude session via the Agent button",
    owners: [SLICE.inject],
  },
  S005: {
    id: "S005",
    instruction: "Let the session reach a waiting state and inspect the bench workspace",
    owners: [SLICE.notify, SLICE.permissions],
  },
  S006: {
    id: "S006",
    instruction:
      "Dismiss the first-run notice and navigate away from and back to the AI Agents screen",
    owners: [SLICE.removal],
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
 * `card` scopes the field: more than one installed agent declares a
 * `configSchema`, and `config-field-*` testids repeat across the cards for every
 * property name they share (`model` and `effort` are shared with the Codex
 * overlay), so a page-wide read matches two controls where it expects one. Keep
 * every `config-field-*` read below scoped the same way.
 */
async function selectChoice(
  page: Page,
  card: Locator,
  field: string,
  optionLabel: string,
): Promise<void> {
  // React Aria's Select renders the trigger as a Button inside the testid'd root
  // and portals its ListBox to the document BODY, so the option is located at
  // page level rather than within the card.
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

/** Poll until the agent session is live, or give up after 10s. */
async function waitForLiveAgentSession(
  request: APIRequestContext,
): Promise<TerminalSessionEntry | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const live = (await listSessions(request)).find(
      (session) => session.agentPluginId === CLAUDE_PLUGIN_ID && session.status === "live",
    );
    if (live !== undefined) return live;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
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

/**
 * Click a target the journey has already TOLERATED a wait for.
 *
 * Playwright sets no action timeout here, so a bare `click()` on a locator that
 * never appeared blocks until the whole test times out, and a timeout reports
 * nothing: it loses the FR-020 attribution AND takes the per-spec teardown with
 * it, so the next spec inherits this one's seeded upgrade residue. The
 * observation that follows each of these clicks is the thing meant to report a
 * missing target, so a missing target is skipped and left to it.
 */
async function clickIfPresent(locator: Locator): Promise<void> {
  if ((await locator.count()) === 1) await locator.click();
}

/** Open Settings and select the AI Agents tab. */
async function openAgentsScreen(page: Page): Promise<void> {
  const res = await page.goto("/settings#ai-agents");
  expect(res?.status(), "GET /settings").toBe(200);
  const tab = page.getByRole("tab", { name: "AI Agents" });
  await expect(tab, "the AI Agents settings tab renders").toBeVisible();
  await tab.click();
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: "The user is upgrading from a build that had built-in agent
  // settings (auto mode on, plan mode on)" and "The first-run notice has not yet
  // been shown". The residue is planted here; the notice's own dismissal marker
  // lives in localStorage, which every Playwright test gets fresh, so nothing
  // has to clear it.
  await seedLegacyAgentSettings(request, LEGACY_AGENT_SETTINGS);

  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
  // S002 is the whole point of this clear: the config form must open on the
  // PLUGIN's own defaults, so nothing may be stored for the agent when it does.
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 530,
            integrationId: "github-com",
            externalId: "530",
            title: "Existing user upgrades and launches with parity intact",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  // What S005-O02 looks for in the bench workspace: the project's permissions,
  // written there by the launch's own descriptor.
  await setProjectPermissions(request, PROJECT_ID, PERMISSIONS);

  // "Launch a jig-driven session via the Agent button" (S004): the primary
  // split-button segment fires the built-in default-agent preset, which carries
  // no jig of its own and so takes the app-level baseline. Pinning the default
  // jig is what makes that baseline this jig rather than the embedded global one.
  const jig = await createProjectJig(request, PROJECT_ID, {
    name: JIG_NAME,
    description: "Confirm the workspace still builds after the upgrade",
    content: JIG_CONTENT,
    agentPluginId: CLAUDE_PLUGIN_ID,
  });
  expectedPrompt = jig.content.replace("{{bench.id}}", String(BENCH_ID));
  await setDefaultJig(request, jig.id);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  // Hand the environment back as a FRESH install. `settings.json` outlives
  // `/test/__reset`, so a residue left here would make every later spec's AI
  // Agents screen render the upgrade notice (NFR-018).
  await seedLegacyAgentSettings(request, null);
  await setDefaultJig(request, null);
  await setDefaultAgent(request, null);
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);
  await setProjectPermissions(request, PROJECT_ID, { allow: [], ask: [], deny: [] });
  clearCapturedArgv();
});

test("AP-TC-102: an upgrading user sees the first-run notice once, configures the plugin, and launches with parity intact (S001-S006)", async ({
  page,
  request,
}) => {
  // Six steps across three surfaces, a PTY spawn and a notification round trip,
  // so the default 30s budget is not the thing under test.
  test.setTimeout(180_000);

  const workspacePath = await readBenchWorkspacePath(request, PROJECT_ID, BENCH_ID);

  // --- S001: the first-run notice on the AI Agents screen -------------------
  await openAgentsScreen(page);
  const notice = page.getByTestId(NOTICE_TESTID);
  // A TOLERATED wait, not an assertion: a notice that never renders leaves the
  // observations below to report the divergence through the FR-020 block rather
  // than failing here as an unattributed Playwright timeout.
  await notice.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // Text is read ONCE so the booleans and the reported actual cannot disagree.
  const noticeCount = await notice.count();
  const noticeText = noticeCount === 1 ? ((await notice.textContent()) ?? "").trim() : "";
  observe(
    STEPS.S001,
    "S001-O01",
    noticeCount === 1 &&
      /agent plugin/i.test(noticeText) &&
      /set its defaults here/i.test(noticeText),
    "a first-run notice banner states that agent configuration moved to plugin settings",
    noticeCount === 1 ? JSON.stringify(noticeText) : "no first-run notice rendered",
  );
  observe(
    STEPS.S001,
    "S001-O02",
    noticeCount === 1 && /not carried over/i.test(noticeText),
    "the notice states that the previous preferences were not migrated (see the header note on the copy)",
    noticeCount === 1 ? JSON.stringify(noticeText) : "no first-run notice rendered",
  );

  // --- S002: the config form opens on the PLUGIN's own defaults -------------
  const disclosure = page.getByTestId(`agent-configure-${CLAUDE_PLUGIN_ID}`);
  await disclosure.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  // The card mounts with its disclosure OPEN (the per-plugin config is the whole
  // point of the screen), so only press Configure when it is collapsed.
  const disclosureLabel =
    (await disclosure.count()) === 1 ? ((await disclosure.textContent()) ?? "") : "";
  if (!disclosureLabel.includes("Hide")) await clickIfPresent(disclosure);
  const form = page.getByTestId(`agent-config-form-${CLAUDE_PLUGIN_ID}`);
  await form.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

  // Each read is count-guarded for the same reason the clicks are: a field that
  // never rendered would otherwise block the whole test instead of reaching the
  // observation that is meant to report it.
  const card = page.getByTestId(`agent-plugin-card-${CLAUDE_PLUGIN_ID}`);
  const fieldText = async (field: string): Promise<string> => {
    const locator = card.getByTestId(`config-field-${field}`);
    return (await locator.count()) === 1 ? ((await locator.textContent()) ?? "").trim() : "";
  };
  const extraArgsInput = card.getByTestId("config-field-extraArgs").locator("input");
  const shown = {
    model: await fieldText("model"),
    effort: await fieldText("effort"),
    mode: await fieldText("mode"),
    extraArgs:
      (await extraArgsInput.count()) === 1 ? await extraArgsInput.inputValue() : "<absent>",
  };
  // The stored record is the other half of the evidence: a form showing the
  // schema's defaults over a config silently derived from the residue would be
  // indistinguishable on screen, and this is exactly the migration the notice
  // promises did not happen.
  const configRes = await request.get(`/api/agents/${CLAUDE_PLUGIN_ID}/config`);
  expect(configRes.status(), `GET /api/agents/${CLAUDE_PLUGIN_ID}/config`).toBe(200);
  const stored = (await configRes.json()) as { config?: Record<string, unknown> };
  observe(
    STEPS.S002,
    "S002-O01",
    shown.model.includes(PLUGIN_DEFAULTS.model) &&
      shown.effort.includes(PLUGIN_DEFAULTS.effort) &&
      shown.mode.includes(PLUGIN_DEFAULTS.mode) &&
      shown.extraArgs === "" &&
      Object.keys(stored.config ?? {}).length === 0,
    `the form shows the plugin's own defaults (${JSON.stringify(PLUGIN_DEFAULTS)}, no extra arguments) and nothing is stored for the agent`,
    `shown=${JSON.stringify(shown)}, stored config=${JSON.stringify(stored.config ?? {})}`,
  );

  // --- S003: choosing opus / high / plan and saving --------------------------
  await selectChoice(page, card, "model", "Opus");
  await selectChoice(page, card, "effort", "High");
  await selectChoice(page, card, "mode", "Plan");
  const save = page.getByTestId(`agent-config-save-${CLAUDE_PLUGIN_ID}`);
  await expect(save, "Save defaults is enabled once the draft diverges").toBeEnabled();
  await save.click();
  // Tolerated wait: the "Saved." indicator is how long to wait for the round
  // trip, not the observation. S003-O01 reads the persisted record back through
  // the real API, so a save that silently failed is reported there.
  await form
    .getByText("Saved.")
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  const savedRes = await request.get(`/api/agents/${CLAUDE_PLUGIN_ID}/config`);
  expect(savedRes.status(), `GET /api/agents/${CLAUDE_PLUGIN_ID}/config`).toBe(200);
  const saved = (await savedRes.json()) as { config?: Record<string, unknown> };
  observe(
    STEPS.S003,
    "S003-O01",
    JSON.stringify(saved.config ?? {}) === JSON.stringify(CHOSEN),
    `the plugin defaults are persisted as ${JSON.stringify(CHOSEN)}`,
    `persisted config=${JSON.stringify(saved.config ?? {})}`,
  );

  // --- S004: the jig-driven launch still injects, exactly as before ----------
  const benchRes = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(benchRes?.status(), "GET the bench detail page").toBe(200);
  const terminalTab = page.getByRole("tab", { name: "Terminal" });
  await expect(terminalTab, "the bench detail view has a Terminal tab").toBeVisible();
  await terminalTab.click();

  clearCapturedArgv();
  // The primary segment's accessible name IS the resolved default agent, so
  // pressing it by that name is what makes this "the Agent button".
  const launchButton = page.getByRole("button", { name: `Launch ${CLAUDE_AGENT_NAME}` });
  await launchButton.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  await clickIfPresent(launchButton);

  const live = await waitForLiveAgentSession(request);
  const argv = await waitForCapturedArgv();
  const captured = argv ?? [];
  // `--session-id <uuid>` is the descriptor's stable argv tail; the host appends
  // the initial prompt after it as the last positional.
  const sessionIdIndex = captured.indexOf("--session-id");
  const generated = sessionIdIndex >= 0 ? captured.slice(0, sessionIdIndex) : captured;
  const positional = sessionIdIndex >= 0 ? captured.slice(sessionIdIndex + 2) : [];
  observe(
    STEPS.S004,
    "S004-O01",
    live !== undefined &&
      JSON.stringify(generated) === JSON.stringify(EXPECTED_FLAGS) &&
      positional.length === 1 &&
      positional[0] === expectedPrompt,
    `a ${CLAUDE_AGENT_NAME} session starts on the saved defaults (${EXPECTED_FLAGS.join(" ")}) with the jig content injected verbatim: ${JSON.stringify(expectedPrompt)}`,
    `session: ${live ? `${live.id} live` : "no live agent session"}; argv: ${argv === null ? "never captured, the child did not run" : JSON.stringify(captured)}`,
  );
  const sessionId = live?.id ?? "";

  // --- S005: the waiting notification, and what the launch wrote ------------
  // Leaving the bench screen first is what makes the notification observation
  // deterministic rather than a race: `TerminalTabs` auto-dismisses the focused
  // tab's own notifications, and a launch focuses its own tab. The AI Agents
  // screen is where S006 goes next anyway.
  await openAgentsScreen(page);
  const hookStatus = await fireWaitingHook(request, sessionId);
  const waiting = await waitForBenchNotification(request, {
    projectId: PROJECT_ID,
    benchId: BENCH_ID,
    type: "agent-waiting",
    sessionId,
  });
  observe(
    STEPS.S005,
    "S005-O01",
    hookStatus === 200 && waiting.found,
    `a waiting notification is raised for session ${sessionId} (the hook endpoint correlates the event to it, 200)`,
    `POST ${HOOK_ENDPOINT} -> ${hookStatus}; bench notifications: ${waiting.seen}`,
  );

  // Read off disk, not through an API: the case is about the file the agent
  // itself reads at startup, and only the file is evidence of that.
  const settingsFile = path.join(workspacePath, SETTINGS_REL_PATH);
  let workspaceSettings: Record<string, unknown> | null = null;
  if (fs.existsSync(settingsFile)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        workspaceSettings = parsed as Record<string, unknown>;
      }
    } catch {
      workspaceSettings = null;
    }
  }
  const writtenRules = (workspaceSettings?.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(writtenRules.allow) ? (writtenRules.allow as string[]) : [];
  const ask = Array.isArray(writtenRules.ask) ? (writtenRules.ask as string[]) : [];
  const deny = Array.isArray(writtenRules.deny) ? (writtenRules.deny as string[]) : [];
  const hooks = (workspaceSettings?.hooks ?? {}) as Record<string, unknown>;
  const notificationHook = JSON.stringify(hooks.Notification ?? null);
  observe(
    STEPS.S005,
    "S005-O02",
    workspaceSettings !== null &&
      PERMISSIONS.allow.every((rule) => allow.includes(rule)) &&
      PERMISSIONS.ask.every((rule) => ask.includes(rule)) &&
      PERMISSIONS.deny.every((rule) => deny.includes(rule)) &&
      notificationHook.includes(HOOK_ENDPOINT),
    `${SETTINGS_REL_PATH} carries the project permissions (${JSON.stringify(PERMISSIONS)}) and the notification hook wired to ${HOOK_ENDPOINT}`,
    workspaceSettings === null
      ? `no readable ${settingsFile}`
      : `permissions=${JSON.stringify({ allow, ask, deny })}, hooks.Notification=${notificationHook}`,
  );

  // --- S006: dismissing the notice is remembered ----------------------------
  const dismiss = page.getByRole("button", { name: "Dismiss agent settings notice" });
  await expect(dismiss, "the first-run notice offers a dismiss action").toBeVisible();
  await dismiss.click();
  await page.goto("/");
  await openAgentsScreen(page);
  // Give the notice every chance to come back before reading the count: it is
  // gated on a settings fetch, so a zero read too early would pass for the wrong
  // reason.
  await page
    .getByTestId(`agent-plugin-card-${CLAUDE_PLUGIN_ID}`)
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  const reappeared = await page.getByTestId(NOTICE_TESTID).count();
  // The residue is still on disk (nothing removes it), so the server still
  // reports the install as an upgrade. Only the remembered dismissal keeps the
  // notice down, which is what makes this "exactly once" rather than "until the
  // signal goes away".
  const settingsRes = await request.get("/api/settings");
  expect(settingsRes.status(), "GET /api/settings").toBe(200);
  const stillUpgrading = ((await settingsRes.json()) as { legacyAgentSettingsPresent?: boolean })
    .legacyAgentSettingsPresent;
  observe(
    STEPS.S006,
    "S006-O01",
    reappeared === 0 && stillUpgrading === true,
    "the first-run notice does not reappear after navigating away and back, even though the install still reports as an upgrade",
    `notices on screen=${reappeared}, legacyAgentSettingsPresent=${String(stillUpgrading)}`,
  );
});
