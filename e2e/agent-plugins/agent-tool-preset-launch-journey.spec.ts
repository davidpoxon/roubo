import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import { clearCapturedArgv, readCapturedArgv } from "./_support/argv-log.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  CODEX_PLUGIN_ID,
  clearAgentConfig,
  consentAgent,
  createAppJig,
  deleteAppJig,
  disablePlugin,
  enablePlugin,
  readAppAgentTools,
  setAppAgentTools,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-024".
const observe = makeObserve("AP-TC-024");

// AP-TC-024 (#528, AP-WU-027) - E2E: create an app-level agent tool preset in
// Settings, then launch it from a bench Terminal tab.
//
// ONE test carries the bare id and it asserts EVERY observation of the case
// (#680). Before this spec no test carried AP-TC-024 at all.
//
// WHY A BROWSER, not jsdom. The case is a single ordered journey across two
// surfaces that no unit test can join up: what Settings WRITES has to be what
// the bench launch menu LAUNCHES. The two halves are already guarded apart
// (AP-TC-025 for the editor, AP-TC-026/027 for the launch menu); the drift this
// file exists to catch lives in the seam between them, where a preset saved by
// the editor travels through settings persistence, app-scoped preset
// resolution, the launch menu and the launch pipeline into a spawned child.
//
// The launched argv is read back from the child's OWN `process.argv` (the
// `roubo-e2e-claude-stub` binary writes it to AGENT_ARGV_LOG_PATH), so "launches
// with the preset's effective params" is evidence rather than a host-side
// reconstruction of our own arithmetic.
//
// JIG INJECTION is observed twice, because neither channel alone says the whole
// thing. The create response's `jigInjected` is the SERVER's report that it
// resolved the jig and handed its content to the session; the resolved content
// arriving as the child's last positional argv is the CHILD's own evidence that
// it got there. The claude-code overlay declares `initialPrompt.mode:
// argv-positional`, which is what puts the jig where the stub can capture it.
// What neither proves is that a real CLI would then act on it, and asserting the
// stub's stdin would need a capture channel the fixture does not have.
//
// PRECONDITIONS. "Claude Code and Codex CLI are both installed and configured"
// is the two bundled e2e overlays. The SECOND agent is not decoration: with only
// one available agent, `resolveLaunchAgentId` falls back to it whenever the
// binding is missing or unusable, so a regression that stopped honouring the
// preset's own `claude-code` binding would still start Claude Code and S004
// would pass anyway. "Custom jig 'Refactor pass' exists" is created here through
// the same route the Jigs screen uses, since no other agent-plugin spec seeds
// an app-level jig.

const SETTINGS_PATH = "/settings";
const PROJECT_ID = "ap-tc-024-preset-launch";
const BENCH_ID = 1;

/** The preset the case builds, named exactly as it scripts it. */
const PRESET_NAME = "Deep work";

/** The case's precondition jig. Its id is `slugify(name)` (jig-manager.ts). */
const JIG_NAME = "Refactor pass";
const JIG_ID = "refactor-pass";
/**
 * Deliberately free of `{{...}}` template variables, so `resolveJigContent`
 * hands the child back exactly this string and the positional-argv observation
 * can compare against a literal rather than against a re-resolved template.
 */
const JIG_CONTENT = "Take a structured refactor pass over the changed files.";

/** The three overrides S002 sets. All are valid values in Claude Code's schema. */
const OVERRIDES = { model: "opus", effort: "max", mode: "plan" } as const;

/**
 * The argv the overlay generates for those overrides, in the order its
 * `buildArgs` fixes (index.mjs): `--model`, `--effort`, `--permission-mode`,
 * each value its own argv entry, all of it ahead of the `--session-id` tail.
 */
const EXPECTED_ARGV_PREFIX = [
  "--model",
  OVERRIDES.model,
  "--effort",
  OVERRIDES.effort,
  "--permission-mode",
  OVERRIDES.mode,
];

const AGENT_TOOLS_SECTION = "Agent tools";
const SAVED_TOAST = "Agent tool saved.";

// The slice issues this work unit is blocked by, used by the FR-020
// failure-output contract to attribute a divergence to the slice that owns it.
const SLICE = {
  contract: {
    issue: 502,
    title: "Spike: validate the agent-contract shape against Claude Code and Codex",
  },
  pipeline: {
    issue: 510,
    title: "Core agent launch pipeline: PTY sessions from declarative launch descriptors",
  },
  presets: {
    issue: 516,
    title: "Agent tools: launch presets with editor, built-ins, and roubo.yaml support",
  },
  a11y: { issue: 524, title: "Accessibility audit of the agent surfaces (WCAG 2.1 AA)" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "In Settings, Jigs, Agent tools, click 'New agent tool'",
    owners: [SLICE.presets, SLICE.a11y],
  },
  S002: {
    id: "S002",
    instruction:
      "Set Name to 'Deep work', Agent to Claude Code, Model opus, Effort max, Mode plan, Jig 'Refactor pass'",
    owners: [SLICE.presets],
  },
  S003: {
    id: "S003",
    instruction: "Click Save",
    owners: [SLICE.presets, SLICE.a11y],
  },
  S004: {
    id: "S004",
    instruction: "Open the Terminal-tab launch menu and click 'Deep work' under 'Agent tools'",
    owners: [SLICE.presets, SLICE.pipeline, SLICE.contract],
  },
};

interface TerminalSessionEntry {
  id: string;
  status: string;
  label?: string;
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
 * tab is created" and leave an idling stub behind (NFR-018).
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

/** Open Settings and switch to the Jigs tab, which hosts the Agent tools list. */
async function openJigsTab(page: Page): Promise<void> {
  const res = await page.goto(SETTINGS_PATH);
  expect(res?.status(), `GET ${SETTINGS_PATH}`).toBe(200);
  const tab = page.getByRole("tab", { name: "Jigs" });
  await expect(tab, "the Jigs settings tab renders").toBeVisible();
  await tab.click();
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
  // The menu is data-INDEPENDENT: its sections render before `useAgentPresets`
  // resolves, so waiting on the menu alone would let the preset row be read
  // before the list arrives. Also tolerated, for the same reason.
  await menu
    .locator('[data-testid^="launch-preset-"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  return menu;
}

test.beforeEach(async ({ request }) => {
  await destroyAllSessions(request);

  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
  // S004 asserts an argv, and an app-level default left behind by another spec
  // would layer underneath the preset's overrides and change it.
  await clearAgentConfig(request, CLAUDE_PLUGIN_ID);

  // App-level presets live in settings.json, which /test/__reset does not clear,
  // so a preset saved by an earlier run would still be listed and S003 could read
  // the wrong row (NFR-018).
  await setAppAgentTools(request, []);

  // Precondition: "Custom jig 'Refactor pass' exists". Left over from an earlier
  // run it would make the create below fail as a duplicate, so clear it first.
  await deleteAppJig(request, JIG_ID);
  const jigId = await createAppJig(request, {
    name: JIG_NAME,
    description: "AP-TC-024 precondition jig",
    content: JIG_CONTENT,
  });
  expect(jigId, "the app jig's id is the slug of its name").toBe(JIG_ID);

  const register = await request.post("/test/__register-fixture-project", {
    data: {
      projectId: PROJECT_ID,
      seedBenches: [
        {
          assignedIssue: {
            number: 528,
            integrationId: "github-com",
            externalId: "528",
            title: "Create an app-level agent-tool preset then launch it from the Terminal tab",
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
  await deleteAppJig(request, JIG_ID);
  // Hand the environment back with exactly one available agent again: the second
  // overlay is opt-in per spec, and AP-TC-087's single-available-agent fallback
  // depends on it being off.
  await disablePlugin(request, CODEX_PLUGIN_ID);
  clearCapturedArgv();
});

test("AP-TC-024: save an app-level agent tool preset and launch it from the bench Terminal tab (S001-S004)", async ({
  page,
  request,
}) => {
  await openJigsTab(page);

  // --- S001: the preset editor opens ----------------------------------------
  const newTool = page.getByRole("button", { name: "New agent tool" });
  await expect(newTool, "the Agent tools section offers New agent tool").toBeVisible();
  await newTool.click();

  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const heading = dialog.getByRole("heading", { name: "Agent tool" });
  const dialogCount = await dialog.count();
  const headingCount = await heading.count();
  observe(
    STEPS.S001,
    "S001-O01",
    dialogCount === 1 && headingCount === 1,
    'the preset editor opens as one dialog titled "Agent tool"',
    `dialogs=${dialogCount}, "Agent tool" headings inside them=${headingCount}`,
  );

  // --- S002: fill the form exactly as the case scripts it -------------------
  // No observations: the case makes this a setup step. It is still written
  // through the real controls, because a field the editor would not accept has
  // to fail HERE rather than as a puzzling S003 divergence.
  await page.locator("#agent-tool-name").fill(PRESET_NAME);
  // The claude-code PLUGIN, not the "Default agent" binding: the case says
  // "Agent to Claude Code", and the two are different bindings that happen to
  // resolve to the same agent under this spec's default.
  await page.locator("#agent-tool-agent").selectOption(CLAUDE_PLUGIN_ID);
  await page.locator("#agent-tool-model").selectOption(OVERRIDES.model);
  await page.locator("#agent-tool-effort").selectOption(OVERRIDES.effort);
  await page.locator("#agent-tool-mode").selectOption(OVERRIDES.mode);
  await page.locator("#agent-tool-jig").selectOption(JIG_ID);

  // --- S003: save, then read the toast and the list row ---------------------
  await dialog.getByRole("button", { name: "Save" }).click();

  // The toast is read FIRST and without an intervening await: it self-dismisses
  // after 3s, so anything slower than the toast turns a real confirmation into a
  // phantom divergence. `role="status"` locates it without matching on the text
  // the observation is about.
  const toast = page.getByRole("status");
  await toast.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  const toastText = (
    (await toast
      .first()
      .textContent()
      .catch(() => "")) ?? ""
  ).trim();
  const dialogHidden = await dialog
    .waitFor({ state: "hidden", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  observe(
    STEPS.S003,
    "S003-O01",
    dialogHidden && toastText === SAVED_TOAST,
    `the editor closes and a toast confirms ${JSON.stringify(SAVED_TOAST)}`,
    `dialog hidden=${dialogHidden}, toast=${JSON.stringify(toastText)}`,
  );

  // What was PERSISTED, through the real API rather than the list's optimistic
  // state. Polled because the row is on screen before the settings write lands,
  // so a single read here would race it. The saved id is also what S004 needs to
  // address the preset's own menu row.
  let persisted: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40 && saved === undefined; attempt += 1) {
    persisted = await readAppAgentTools(request);
    saved = persisted.find((preset) => preset.name === PRESET_NAME);
    if (saved === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const row = page.getByTestId("agent-tool-row").filter({ hasText: PRESET_NAME });
  // A TOLERATED wait, not an assertion: a row that never appears reports through
  // the observation below with its own attribution block.
  await row
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  const rowCount = await row.count();
  const subtitle =
    rowCount === 1
      ? ((await row.getByTestId("agent-tool-binding").locator("..").textContent()) ?? "").trim()
      : "";
  // The case's own wording: bound to Claude Code, then the three overrides and
  // the jig, separated by the middle dot the component renders.
  const expectedSubtitle = [
    CLAUDE_AGENT_NAME,
    OVERRIDES.model,
    OVERRIDES.effort,
    OVERRIDES.mode,
    JIG_NAME,
  ].join(" · ");
  observe(
    STEPS.S003,
    "S003-O02",
    saved !== undefined &&
      saved.agent === CLAUDE_PLUGIN_ID &&
      JSON.stringify(saved.params ?? {}) === JSON.stringify(OVERRIDES) &&
      saved.jig === JIG_ID &&
      rowCount === 1 &&
      subtitle === expectedSubtitle,
    `"${PRESET_NAME}" is listed once, persisted as agent=${CLAUDE_PLUGIN_ID} params=${JSON.stringify(OVERRIDES)} jig=${JIG_ID}, and its subtitle reads ${JSON.stringify(expectedSubtitle)}`,
    `persisted=${saved === undefined ? JSON.stringify(persisted) : JSON.stringify(saved)}; rows=${rowCount}, subtitle=${JSON.stringify(subtitle)}`,
  );

  const presetId = typeof saved?.id === "string" ? saved.id : "";

  // --- S004: launch it from the bench Terminal tab --------------------------
  await openTerminalTab(page);
  const menu = await openLaunchMenu(page);

  const agentToolsGroup = page.getByRole("group", { name: AGENT_TOOLS_SECTION });
  const presetItem =
    presetId === ""
      ? menu.getByTestId("launch-preset-__absent__")
      : agentToolsGroup.getByTestId(`launch-preset-${presetId}`);
  const presetItemCount = await presetItem.count();
  // Routed through the observer rather than a bare `expect`: a preset missing
  // from the launch menu is the likeliest S004 failure, and it is a divergence
  // of this step, so its failure has to name the step the way every other
  // observation here does (FR-020). The observer throws on a false `ok` exactly
  // as `expect` did, so the click below stays unreachable on failure.
  observe(
    STEPS.S004,
    "S004-O01",
    presetItemCount === 1,
    `"${PRESET_NAME}" is listed once under "${AGENT_TOOLS_SECTION}" in the launch menu`,
    `rows=${presetItemCount}`,
  );

  // Unlink first so the argv read below can only be this launch's.
  clearCapturedArgv();
  // Armed BEFORE the click: the create response is the server's own report of
  // what it did with the jig, and it is gone by the time the session shows up on
  // the list route.
  const createResponse = page
    .waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        new URL(res.url()).pathname === `/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/terminals`,
      { timeout: 20_000 },
    )
    .catch(() => null);
  await presetItem.click();

  const created = await createResponse;
  const createBody = created === null ? null : ((await created.json()) as Record<string, unknown>);
  const createRequestBody =
    created === null ? null : (created.request().postDataJSON() as Record<string, unknown>);

  const { live, seen } = await waitForLiveAgentSession(request, CLAUDE_PLUGIN_ID);
  const argv = await waitForCapturedArgv();
  const captured = argv ?? [];
  // `--session-id <uuid>` is the descriptor's stable argv tail: everything
  // before it is the region the preset's overrides assemble into, and the single
  // entry after the uuid is the injected jig, which the overlay declares as an
  // `argv-positional` initial prompt.
  const sessionIdIndex = captured.indexOf("--session-id");
  const generated = sessionIdIndex >= 0 ? captured.slice(0, sessionIdIndex) : captured;
  // Trailing whitespace is trimmed off the positional: a jig is a markdown FILE,
  // so its stored content is newline-terminated, and the injected prompt carries
  // that terminator. What the observation is about is the jig's text arriving,
  // not how the file happens to end.
  const positional = (sessionIdIndex >= 0 ? captured.slice(sessionIdIndex + 2) : []).map((entry) =>
    entry.replace(/\s+$/, ""),
  );
  observe(
    STEPS.S004,
    "S004-O02",
    live !== undefined &&
      argv !== null &&
      sessionIdIndex >= 0 &&
      JSON.stringify(generated) === JSON.stringify(EXPECTED_ARGV_PREFIX) &&
      createRequestBody?.jigId === JIG_ID &&
      createBody?.jigInjected === true &&
      JSON.stringify(positional) === JSON.stringify([JIG_CONTENT]),
    `a live ${CLAUDE_AGENT_NAME} session opens whose argv carries the preset's effective params as ${JSON.stringify(EXPECTED_ARGV_PREFIX)}, and the "${JIG_NAME}" jig is injected: the launch requests jigId=${JIG_ID}, the server reports jigInjected, and the child receives the jig's content as its positional prompt`,
    `session: ${live ? `${live.id} live agent=${live.agentPluginId}` : describeSessions(seen)}; argv: ${argv === null ? "never captured, the child did not run" : JSON.stringify(captured)}; create request=${JSON.stringify(createRequestBody)}; create response=${JSON.stringify(createBody)}`,
  );

  // The tab bar renders each session inline with no per-tab testid, so a session
  // tab is the element carrying the agent icon. The bench started with no
  // sessions (see beforeEach), so exactly one is the new one, and its text is
  // the session's own label shortened at the " - " the server joins on.
  const tab = page.getByTestId("session-agent-icon").locator("..");
  await tab
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  const tabCount = await tab.count();
  const tabText = tabCount === 1 ? ((await tab.textContent()) ?? "").trim() : "";
  const expectedTabText = (live?.label ?? "").split(" - ")[0];
  observe(
    STEPS.S004,
    "S004-O03",
    tabCount === 1 && expectedTabText !== "" && tabText === expectedTabText,
    `the tab bar gains exactly one session tab, labelled ${JSON.stringify(expectedTabText === "" ? `${CLAUDE_AGENT_NAME} 1` : expectedTabText)} for the session the preset launched`,
    `session tabs=${tabCount}, text=${JSON.stringify(tabText)}, launched session label=${JSON.stringify(live?.label ?? null)}`,
  );
});
