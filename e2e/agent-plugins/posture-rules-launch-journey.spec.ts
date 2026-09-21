import fs from "node:fs";
import path from "node:path";
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
  readBenchWorkspacePath,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "APCC-TC-038".
const observe = makeObserve("APCC-TC-038");

// APCC-TC-038 (#870): a developer sets a posture and project rules, then
// launches.
//
// The integration-level drift guard for the APCC-FR-015 / APCC-FR-016 /
// APCC-US-005 journey. It walks the authoritative APCC-TC-038 e2e_flow steps
// S001-S005 (.specifications/agent-plugins-cursor-cli/test-cases.json in the
// meta-repo) as ordered, attributable observations against the REAL built app:
// the capabilities route that reads the plugin's declared postures and its
// manifest `agentPermissionRuleTiers`, the permissions screen that gates its
// controls on them, the permissions store, the launch pipeline that hands the
// saved posture and rules to the plugin, the host appending the posture's
// declared args to the spawned argv, and the host executing the declared
// `.cursor/cli.json` write into the bench workspace. On divergence each
// observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice(s).
//
// HOW THE PLUGIN IS PROVIDED. The `cursor-cli` bundled overlay
// (e2e/fixtures/bundled-overlays/cursor-cli/) mirrors the shipped plugin's
// posture table, rule tiers and rules write, and names `roubo-e2e-cursor-stub`
// (e2e/fixtures/bin/, on the server's PATH) as its command. The stub records the
// argv it was spawned with to CURSOR_ARGV_LOG_PATH, which is how S005 reads the
// command. The overlay is force-DISABLED by every /test/__reset
// (OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts), so this spec opts
// in and hands the environment back the way it found it.

const PROJECT_ID = "apcc-us-005-cursor-permissions-journey";
const BENCH_ID = 1;
const PERMISSIONS_PATH = `/projects/${PROJECT_ID}/settings/permissions`;

/** The command the `cursor-cli` overlay's launch descriptor names. */
const CURSOR_COMMAND = "roubo-e2e-cursor-stub";

/** The postures the Cursor plugin declares, and the screen label for each. */
const POSTURE_LABELS = {
  "read-only": "Read only",
  guarded: "Ask before acting",
  "auto-edit": "Edit without asking",
  "full-auto": "Fully autonomous",
} as const;

/** The one tier the Cursor rules file does not carry. */
const DROPPED_TIER = "ask";

/** The tiers Cursor's rules file carries (APCC-FR-016). */
const CURSOR_TIERS = ["allow", "deny"];

/** The flags the guarded posture binds to (APCC-FR-015). */
const GUARDED_FLAGS = ["--sandbox", "enabled"];

/**
 * The two rules S004 adds. Already in Cursor's typed form, so the rules file
 * carries them unchanged and S005-O02 reads back exactly what S004 typed.
 */
const ALLOW_RULE = "Shell(npm test)";
const DENY_RULE = "Shell(git push)";

/**
 * How long a tolerated wait gives the screen to settle. The posture control
 * mounts only once the capabilities route answers, and that route asks the
 * plugin for a launch descriptor, so a loaded machine can take several seconds.
 */
const SETTLE_TIMEOUT_MS = 30_000;

/** The bench-local rules file the plugin declares (APCC-FR-015). */
const RULES_REL_PATH = ".cursor/cli.json";

// The slices this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice. The journey-to-slice
// mapping is by requirement and story overlap, so each step names a
// conservative superset.
const SLICE = {
  mapping: { title: "Map the permission postures and write the project rules" },
  axes: { title: "Present only the permission axes Cursor supports" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the project permissions screen for a project using the Cursor plugin.",
    owners: [SLICE.axes],
  },
  S002: {
    id: "S002",
    instruction: "Read the axes the screen offers.",
    owners: [SLICE.axes, SLICE.mapping],
  },
  S003: {
    id: "S003",
    instruction: "Choose the guarded posture.",
    owners: [SLICE.axes],
  },
  S004: {
    id: "S004",
    instruction: "Add an allow rule and a deny rule.",
    owners: [SLICE.axes],
  },
  S005: {
    id: "S005",
    instruction: "Launch a Cursor session in a bench.",
    owners: [SLICE.mapping, SLICE.axes],
  },
};

interface PermissionsRecord {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  posture?: string;
}

interface PermissionsCapabilities {
  agentPluginId?: string;
  postures?: string[];
  rules?: boolean;
  ruleTiers?: string[];
}

interface TerminalSessionEntry {
  id: string;
  status: string;
  command?: string;
  agentPluginId?: string;
}

async function readPermissions(request: APIRequestContext): Promise<PermissionsRecord> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/permissions`);
  expect(res.status(), "GET permissions").toBe(200);
  return (await res.json()) as PermissionsRecord;
}

async function readCapabilities(request: APIRequestContext): Promise<PermissionsCapabilities> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/permissions/capabilities`);
  expect(res.status(), "GET permissions capabilities").toBe(200);
  return (await res.json()) as PermissionsCapabilities;
}

/**
 * Empty the project's permissions record, posture included. The PUT replaces
 * the whole record, and `/test/__reset` does not truncate
 * `<rouboDir>/permissions/<projectId>.json`, so this is what stops one run's
 * posture and rules reaching the next.
 */
async function clearPermissions(request: APIRequestContext): Promise<void> {
  const res = await request.put(`/api/projects/${PROJECT_ID}/permissions`, {
    data: { allow: [], deny: [], ask: [] },
  });
  expect(res.status(), "PUT empty permissions").toBe(200);
}

async function listSessions(request: APIRequestContext): Promise<TerminalSessionEntry[]> {
  const res = await request.get(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`);
  if (res.status() !== 200) return [];
  const body = (await res.json()) as TerminalSessionEntry[];
  return Array.isArray(body) ? body : [];
}

/**
 * Drop every terminal session on this spec's bench. Live PTY sessions are NOT
 * cleared by `/test/__reset`, so a session from an earlier run would shadow the
 * one under test and leave an idling stub behind (NFR-018).
 */
async function destroyAllSessions(request: APIRequestContext): Promise<void> {
  for (const session of await listSessions(request)) {
    await request.delete(`/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals/${session.id}`);
  }
}

/**
 * Set the app-level jig behaviour. With auto-inject off no jig rides the argv as
 * a trailing positional, so the captured argv is the generated flags plus the
 * posture's and nothing else.
 */
async function setJigSettings(
  request: APIRequestContext,
  jigs: { autoInject: boolean; autoExecute: boolean },
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

/** The labels a React Aria Select lists once its trigger is opened. */
async function readSelectOptions(page: Page, trigger: Locator): Promise<string[]> {
  if ((await trigger.count()) === 0) return [];
  await trigger.click();
  // The ListBox portals to the document body, so options are read page-wide.
  const options = page.getByRole("listbox").getByRole("option");
  await options
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});
  const labels = (await options.allTextContents()).map((text) => text.trim());
  await page.keyboard.press("Escape");
  await page
    .getByRole("listbox")
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => {});
  return labels;
}

/** Pick one option in a React Aria Select by its label. */
async function chooseOption(page: Page, trigger: Locator, label: string): Promise<void> {
  if ((await trigger.count()) === 0) return;
  await trigger.click();
  await page
    .getByRole("option", { name: label, exact: true })
    .click({ timeout: 5_000 })
    .catch(() => {});
}

/** Add one rule through the screen's composer: tier, pattern, Add. */
async function addRule(page: Page, tier: string, pattern: string): Promise<void> {
  await chooseOption(page, page.getByRole("button", { name: /Rule type/ }).first(), tier);
  await page.getByRole("textbox", { name: "Rule pattern" }).fill(pattern);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

/**
 * Launch Cursor from the bench Terminal tab's "All agents" menu, and answer the
 * launch route's status and body, or why no launch request was sent.
 *
 * With no sessions open the tab bar and the empty state each render a
 * "Choose launch option" chevron; the first is the tab bar's. Each "All agents"
 * row is named `<agent name>: <effective params or blocker>`.
 */
async function launchFromAllAgents(page: Page): Promise<string> {
  const res = await page.goto(`/projects/${PROJECT_ID}/benches/${BENCH_ID}`);
  expect(res?.status(), "GET the bench detail page").toBe(200);
  const tab = page.getByRole("tab", { name: "Terminal" });
  await tab.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await tab.count()) === 0) return "the bench has no Terminal tab";
  await tab.click();

  const trigger = page.getByRole("button", { name: "Choose launch option" }).first();
  await trigger.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await trigger.count()) === 0) return "the Terminal tab has no launch menu";
  await trigger.click();

  const row = page
    .getByRole("group", { name: "All agents" })
    .getByRole("menuitem", { name: new RegExp(`^${CURSOR_AGENT_NAME}:`) });
  await row.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  if ((await row.count()) === 0) return `the All agents menu lists no ${CURSOR_AGENT_NAME} row`;

  const pending = page
    .waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes(`/benches/${BENCH_ID}/terminals`),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await row.click();
  const response = await pending;
  if (response === null) return "no launch request was sent";
  return `${response.status()} ${await response.text().catch(() => "")}`;
}

/** Poll until `read` answers a value `done` accepts, answering the last read. */
async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < 40 && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

/** Whether `argv` carries `tokens` as one contiguous run. */
function containsRun(argv: string[], tokens: string[]): boolean {
  return argv.some((_, start) => tokens.every((token, i) => argv[start + i] === token));
}

/** The bench rules file, parsed, or a description of why it could not be read. */
function readRulesFile(workspace: string): { doc?: Record<string, unknown>; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(workspace, RULES_REL_PATH), "utf-8");
  } catch (err) {
    return { error: `${RULES_REL_PATH} could not be read: ${(err as Error).message}` };
  }
  try {
    return { doc: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { error: `${RULES_REL_PATH} is not JSON: ${JSON.stringify(raw)}` };
  }
}

test.beforeEach(async ({ request }) => {
  test.setTimeout(180_000);

  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  await enablePlugin(request, CURSOR_PLUGIN_ID);
  await consentAgent(request, CURSOR_PLUGIN_ID);
  await waitForAvailableAgents(request, [CURSOR_PLUGIN_ID]);
  // A saved mode would add a `--mode` flag the journey never set (NFR-018).
  await clearAgentConfig(request, CURSOR_PLUGIN_ID);

  // Settings first: setDefaultAgent preserves the jig block it reads back.
  await setJigSettings(request, { autoInject: false, autoExecute: true });
  // The project "uses the Cursor plugin" through the default agent, which is
  // what the capabilities route resolves the project's agent from.
  await setDefaultAgent(request, CURSOR_PLUGIN_ID);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 870,
            integrationId: "github-com",
            externalId: "870",
            title: "e2e: A developer sets a posture and project rules, then launches",
          },
        },
      ],
    },
  });
  expect(register.status(), "POST /test/__register-fixture-project").toBe(200);

  await clearPermissions(request);
  clearCapturedCursorArgv();

  // The precondition, "a project using the Cursor plugin", holds only once the
  // capabilities route resolves the default agent to Cursor. Right after the
  // overlay is enabled it can briefly read as unavailable, and the route then
  // falls back to the lone available agent, so wait for it here rather than let
  // S002 observe a setup race as drift.
  const resolved = await pollUntil(
    () => readCapabilities(request),
    (caps) => caps.agentPluginId === CURSOR_PLUGIN_ID,
  );
  expect(
    resolved.agentPluginId,
    `the project's agent resolves to ${CURSOR_PLUGIN_ID}; capabilities=${JSON.stringify(resolved)}`,
  ).toBe(CURSOR_PLUGIN_ID);
});

test.afterEach(async ({ request }) => {
  await destroyAllSessions(request);
  await clearPermissions(request);
  await setJigSettings(request, { autoInject: true, autoExecute: true });
  await setDefaultAgent(request, null);
  await clearAgentConfig(request, CURSOR_PLUGIN_ID);
  // Hand the environment back with the opt-in overlay off again: the
  // lone-available-agent fallback other specs lean on depends on it (NFR-018).
  await disablePlugin(request, CURSOR_PLUGIN_ID);
  clearCapturedCursorArgv();
});

test(
  "APCC-TC-038: a developer sets a posture and project rules, then launches (S001-S005)",
  { tag: "@APCC-TC-038" },
  async ({ page, request }) => {
    // --- S001: the permissions screen renders for the Cursor project ---------
    const res = await page.goto(PERMISSIONS_PATH);
    expect(res?.status(), `GET ${PERMISSIONS_PATH}`).toBe(200);
    const heading = page.getByRole("heading", { name: "Agent permissions" });
    const composer = page.getByRole("textbox", { name: "Rule pattern" });
    await composer.waitFor({ state: "visible", timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    const headingCount = await heading.count();
    const composerCount = await composer.count();
    observe(
      STEPS.S001,
      "S001-O01",
      headingCount === 1 && composerCount === 1,
      'the screen renders its "Agent permissions" heading and finishes loading',
      `heading count=${headingCount}, rule composer count=${composerCount}`,
    );

    // --- S002: only the axes Cursor supports are offered ---------------------
    // What the screen is told, read through the real route, then what it shows.
    const capabilities = await readCapabilities(request);
    const postureTrigger = page.getByRole("button", { name: /Permission posture/ });
    await postureTrigger.waitFor({ state: "visible", timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    const postureOptions = await readSelectOptions(page, postureTrigger);
    const tierOptions = await readSelectOptions(
      page,
      page.getByRole("button", { name: /Rule type/ }).first(),
    );
    const notice = page.getByText(
      new RegExp(
        `${CURSOR_AGENT_NAME} has no ${DROPPED_TIER} tier, so a rule marked ${DROPPED_TIER} is never written`,
      ),
    );
    const noticeCount = await notice.count();

    const expectedPostureOptions = ["Agent default", ...Object.values(POSTURE_LABELS)];
    observe(
      STEPS.S002,
      "S002-O01",
      capabilities.agentPluginId === CURSOR_PLUGIN_ID &&
        JSON.stringify(capabilities.ruleTiers) === JSON.stringify(CURSOR_TIERS) &&
        JSON.stringify(postureOptions) === JSON.stringify(expectedPostureOptions) &&
        JSON.stringify(tierOptions) === JSON.stringify(CURSOR_TIERS) &&
        noticeCount === 1,
      `the ${CURSOR_PLUGIN_ID} capabilities carry rule tiers ${JSON.stringify(CURSOR_TIERS)}; ` +
        `the posture control offers ${JSON.stringify(expectedPostureOptions)}; ` +
        `the rule tier picker offers ${JSON.stringify(CURSOR_TIERS)} with no "${DROPPED_TIER}"; ` +
        `and the screen states that an ${DROPPED_TIER} rule is never written`,
      `capabilities=${JSON.stringify(capabilities)}, posture options=${JSON.stringify(postureOptions)}, ` +
        `tier options=${JSON.stringify(tierOptions)}, not-written notice count=${noticeCount}`,
    );

    // --- S003: choose the guarded posture; it persists -----------------------
    await chooseOption(page, postureTrigger, POSTURE_LABELS.guarded);
    const savedPosture = await pollUntil(
      () => readPermissions(request),
      (record) => record.posture === "guarded",
    );
    // Persisted, not only held in the screen's optimistic state.
    await page.reload();
    await expect(postureTrigger)
      .toHaveText(POSTURE_LABELS.guarded, { timeout: SETTLE_TIMEOUT_MS })
      .catch(() => {});
    const reloadedPosture = ((await postureTrigger.textContent().catch(() => null)) ?? "").trim();
    observe(
      STEPS.S003,
      "S003-O01",
      savedPosture.posture === "guarded" && reloadedPosture === POSTURE_LABELS.guarded,
      `the saved posture is "guarded" and after a reload the control still shows "${POSTURE_LABELS.guarded}"`,
      `saved posture=${JSON.stringify(savedPosture.posture ?? null)}, control shows ${JSON.stringify(reloadedPosture)}`,
    );

    // --- S004: add an allow rule and a deny rule; both persist ---------------
    await addRule(page, "allow", ALLOW_RULE);
    await page
      .getByText(ALLOW_RULE, { exact: true })
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => {});
    await addRule(page, "deny", DENY_RULE);
    const savedRules = await pollUntil(
      () => readPermissions(request),
      (record) =>
        (record.allow ?? []).includes(ALLOW_RULE) && (record.deny ?? []).includes(DENY_RULE),
    );
    await page.reload();
    const allowRow = page.getByText(ALLOW_RULE, { exact: true }).locator("..");
    const denyRow = page.getByText(DENY_RULE, { exact: true }).locator("..");
    await allowRow.waitFor({ state: "visible", timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await denyRow.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
    const allowBadge = await allowRow.getByText("allow", { exact: true }).count();
    const denyBadge = await denyRow.getByText("deny", { exact: true }).count();
    observe(
      STEPS.S004,
      "S004-O01",
      JSON.stringify(savedRules.allow) === JSON.stringify([ALLOW_RULE]) &&
        JSON.stringify(savedRules.deny) === JSON.stringify([DENY_RULE]) &&
        (savedRules.ask ?? []).length === 0 &&
        savedRules.posture === "guarded" &&
        allowBadge === 1 &&
        denyBadge === 1,
      `the saved record carries allow ${JSON.stringify([ALLOW_RULE])} and deny ${JSON.stringify([DENY_RULE])}, ` +
        "keeps the guarded posture, and after a reload each rule is listed under its own tier",
      `saved record=${JSON.stringify(savedRules)}, allow row badge count=${allowBadge}, ` +
        `deny row badge count=${denyBadge}`,
    );

    // --- S005: launch a Cursor session in a bench ----------------------------
    // From the bench's Terminal tab, through the All agents launch menu. Every
    // wait is tolerated: a launch that never happens has to fail through
    // `observe` so the block names S005 and its owning slices.
    const launch = await launchFromAllAgents(page);
    const sessions = await pollUntil(
      () => listSessions(request),
      (seen) => seen.some((s) => s.agentPluginId === CURSOR_PLUGIN_ID && s.status === "live"),
    );
    const live = sessions.find((s) => s.agentPluginId === CURSOR_PLUGIN_ID && s.status === "live");
    const argv = await pollUntil(
      async () => readCapturedCursorArgv(),
      (captured) => captured !== null,
    );
    observe(
      STEPS.S005,
      "S005-O01",
      live?.command === CURSOR_COMMAND && argv !== null && containsRun(argv, GUARDED_FLAGS),
      `a live ${CURSOR_PLUGIN_ID} session runs ${CURSOR_COMMAND}, and its argv carries the ` +
        `guarded posture flags ${JSON.stringify(GUARDED_FLAGS)}`,
      `launch response=${launch}, sessions=${JSON.stringify(sessions)}, ` +
        `captured argv=${JSON.stringify(argv)}`,
    );

    const workspace = await readBenchWorkspacePath(request, PROJECT_ID, BENCH_ID);
    const { doc, error } = readRulesFile(workspace);
    const rules = (doc?.permissions ?? {}) as Record<string, unknown>;
    const allow = Array.isArray(rules.allow) ? rules.allow : [];
    const deny = Array.isArray(rules.deny) ? rules.deny : [];
    observe(
      STEPS.S005,
      "S005-O02",
      doc !== undefined &&
        allow.includes(ALLOW_RULE) &&
        deny.includes(DENY_RULE) &&
        !allow.includes(DENY_RULE) &&
        !(DROPPED_TIER in rules),
      `${RULES_REL_PATH} in the bench workspace carries permissions.allow with ${ALLOW_RULE} ` +
        `and permissions.deny with ${DENY_RULE}, and no ${DROPPED_TIER} list`,
      error ?? `${RULES_REL_PATH}=${JSON.stringify(doc)}`,
    );
  },
);
