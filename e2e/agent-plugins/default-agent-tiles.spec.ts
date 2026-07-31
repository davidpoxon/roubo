import { expect, test, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  CODEX_AGENT_NAME,
  CODEX_PLUGIN_ID,
  consentAgent,
  disablePlugin,
  enablePlugin,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-018".
const observe = makeObserve("AP-TC-018");

// AP-TC-018 (#681, AP-WU-036) - E2E: selecting a default-agent tile under
// Settings, Jigs selects it, deselects the other, and confirms with a toast.
//
// ONE test carries the bare id and it asserts EVERY observation of the case
// (#680): the suite mapper corroborates a case only when exactly one test claims
// it, and a claimant that covers a third of the case is worse than none. The two
// unit tests that used to split this case between them
// (ProjectSettings.test.tsx, settings.test.ts) keep their coverage and have had
// the bare id removed.
//
// WHY A BROWSER, not jsdom. All three observations are rendered-surface facts:
// which tile carries the check indicator, that no second tile carries it, and
// that a self-dismissing toast appeared. The unit tests can assert the radio's
// checked attribute and that `addToast` was CALLED; only a real render proves
// the tile's selected styling and a toast that actually reached the DOM.
//
// HOW THE TWO-AGENT PRECONDITION IS MET. The case needs "Claude Code and Codex
// CLI are both installed and configured", and with a single available agent the
// picker force-selects it (AP-TC-041), so there would be nothing to observe. The
// second agent is the `codex-cli` bundled overlay at
// e2e/fixtures/bundled-overlays/codex-cli/, which AP-TC-113 (#683) already added
// for its compatibility line. This spec reuses it as-is and needs nothing from
// it beyond its id and name: it never launches through it, and it declares no
// configSchema, so enabling it moves neither the argv log nor the page-wide
// `config-field-*` count that AP-TC-087 reads. Every launch assertion in this
// directory goes through claude-code and its argv-capturing stub.
//
// The overlay is force-DISABLED by every /test/__reset (see
// OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts). Consent has no
// revoke route and outlives the server process, so a second consented agent
// would otherwise leak into every later spec and un-resolve the default that
// AP-TC-087's single-available-agent fallback depends on (NFR-018). This spec
// opts in, and hands the environment back the way it found it.

const SETTINGS_PATH = "/settings";

// The slice issues that own this behaviour, used by the FR-020 failure-output
// contract to attribute a divergence.
const SLICE = {
  picker: { issue: 515, title: "Default agent picker under Settings, Jigs" },
  gate: { issue: 537, title: "Verify gate: Phase 2 Claude Parity & Launch Surfaces" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Click the Codex CLI radio tile in the Default agent group",
    owners: [SLICE.picker, SLICE.gate],
  },
};

/** Open Settings and switch to the Jigs tab, where the picker lives. */
async function openJigsTab(page: Page): Promise<void> {
  const res = await page.goto(SETTINGS_PATH);
  expect(res?.status(), `GET ${SETTINGS_PATH}`).toBe(200);
  const tab = page.getByRole("tab", { name: "Jigs" });
  await expect(tab, "the Jigs settings tab renders").toBeVisible();
  await tab.click();
}

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  // Precondition: both agents installed and configured. The reset left the
  // second-agent overlay disabled, so it is opted into here and consented, which
  // is what makes `resolveAgent` hand out a connection for it.
  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID]);

  // The starting default. Pinned rather than inferred: with two available agents
  // the "exactly one agent, so it is the default" fallback no longer applies, so
  // without this the group would render with no tile selected and "Claude Code
  // deselects" would be vacuously true.
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
});

test.afterEach(async ({ request }) => {
  // Hand the environment back: no default agent pinned, and the second agent
  // switched off again so the next spec sees exactly one available agent.
  await setDefaultAgent(request, null);
  await disablePlugin(request, CODEX_PLUGIN_ID);
});

test("AP-TC-018: selecting the Codex CLI tile moves the default agent (S001)", async ({ page }) => {
  await openJigsTab(page);

  const group = page.getByRole("radiogroup", { name: "Default agent" });
  const claudeTile = page.getByTestId(`default-agent-tile-${CLAUDE_PLUGIN_ID}`);
  const codexTile = page.getByTestId(`default-agent-tile-${CODEX_PLUGIN_ID}`);

  // Preconditions, not observations: both tiles render and Claude Code starts
  // selected. Asserted directly (rather than through `observe`) because a
  // failure here means the fixture never reached the state the case starts
  // from, which is not drift in the behaviour AP-TC-018 is about.
  await expect(claudeTile, `the ${CLAUDE_AGENT_NAME} tile renders`).toBeVisible();
  await expect(codexTile, `the ${CODEX_AGENT_NAME} tile renders`).toBeVisible();
  await expect(claudeTile, `${CLAUDE_AGENT_NAME} starts as the default`).toHaveAttribute(
    "data-selected",
    "true",
  );

  // --- S001: press the Codex CLI tile ---------------------------------------
  // The tile, not the radio input: React Aria renders a zero-size input inside
  // the label, so the tile covering it is both what a user presses and the only
  // thing a click can land on.
  await codexTile.click();

  // The toast is read FIRST because it self-destructs after 3000ms
  // (ToastProvider), so every other read below has to happen after it, not
  // before it. `role="status"` is what makes it locatable without matching on
  // its own text, so the text can be part of what is asserted.
  const toast = page.getByRole("status");
  await toast
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});
  const toastTexts = (await toast.allTextContents()).map((text) => text.trim());

  // Read the selection once, so the boolean and the reported actual can never
  // disagree. `data-selected` mirrors the same `isSelected` that drives the
  // highlight and the filled check indicator, so it is the visual state, not a
  // second source of truth.
  const codexSelected = await codexTile.getAttribute("data-selected");
  const claudeSelected = await claudeTile.getAttribute("data-selected");
  observe(
    STEPS.S001,
    "S001-O01",
    codexSelected === "true" && claudeSelected === "false",
    `the ${CODEX_AGENT_NAME} tile becomes selected and the ${CLAUDE_AGENT_NAME} tile deselects`,
    `codex data-selected=${codexSelected}, claude data-selected=${claudeSelected}`,
  );

  const radios = await group.getByRole("radio").all();
  const checked: string[] = [];
  for (const radio of radios) {
    if (await radio.isChecked()) checked.push((await radio.getAttribute("value")) ?? "?");
  }
  observe(
    STEPS.S001,
    "S001-O02",
    radios.length >= 2 && checked.length === 1 && checked[0] === CODEX_PLUGIN_ID,
    `exactly one of the ${radios.length} tiles is selected, and it is ${CODEX_PLUGIN_ID}`,
    `${radios.length} tiles, selected: ${checked.length === 0 ? "none" : checked.join(", ")}`,
  );

  observe(
    STEPS.S001,
    "S001-O03",
    toastTexts.includes(`Default agent set to ${CODEX_AGENT_NAME}`),
    `a toast reads "Default agent set to ${CODEX_AGENT_NAME}"`,
    toastTexts.length === 0 ? "no toast was shown" : JSON.stringify(toastTexts),
  );
});
