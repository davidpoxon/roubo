import { expect, test, type APIRequestContext } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  clearAgentConfig,
  consentAgent,
  disablePlugin,
  enablePlugin,
  readAgentConfig,
} from "./_support/agent-env.js";
import { clearProbeMode, setProbeMode } from "./_support/probe-mode.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "APCC-TC-002".
const observe = makeObserve("APCC-TC-002");

// APCC-TC-002 (#871): a declared choice probe populates a configuration field
// end to end.
//
// The integration-level drift guard for the APCC-FR-001 / APCC-FR-002 /
// APCC-US-006 journey. It walks the authoritative APCC-TC-002 e2e_flow steps
// S001-S004 (.specifications/agent-plugins-cursor-cli/test-cases.json in the
// meta-repo) as ordered, attributable observations against the REAL built app:
// the manifest's `choiceProbes` declaration, the host probe runner and its
// `dash-line-pairs` parser, the choices served through the agent inventory route,
// the AI Agents form, and the app-level config save. On divergence each
// observation routes through the FR-020 failure-output contract (see
// ../component-plugins/_support/step-runner.ts): the failure reports which step
// diverged, the expected-vs-actual, and the owning slice(s).
//
// HOW THE PLUGIN AND ITS PROBE ARE PROVIDED. The `agent-choice-probe` bundled
// overlay (e2e/fixtures/bundled-overlays/agent-choice-probe/) declares a
// `dash-line-pairs` choice probe on its `probedModel` field, pointed at
// `roubo-e2e-probe-stub` (e2e/fixtures/bin/, on the server's PATH). The stub's
// `slow` mode prints its listing after 4.5 s, so the field reads `loading` long
// enough for S002 to observe it and then resolves for S003. `/test/__reset`
// empties the probe cache, so every run spawns the stub again.
//
// The overlay is force-DISABLED by every /test/__reset (OPT_IN_AGENT_FIXTURE_
// PLUGIN_IDS in server/routes/test.ts), so this spec opts in and hands the
// environment back the way it found it, as the APCC-TC-022 audit does.

const PLUGIN_ID = "agent-choice-probe";
const FIELD = "probedModel";
const SETTINGS_PATH = "/settings#ai-agents";

/** The upper bound on one slow probe run, with room for the spawn itself. */
const PROBE_SETTLE_TIMEOUT_MS = 10_000;

/** The listing `roubo-e2e-probe-stub` prints, as `<identifier> - <label>` pairs. */
const PROBED_CHOICES = [
  { value: "stub-fast", label: "Stub Fast" },
  { value: "stub-balanced", label: "Stub Balanced" },
  { value: "stub-deep", label: "Stub Deep" },
] as const;

/** The choice S004 selects: not the first, so a default cannot pass for a pick. */
const PICK = PROBED_CHOICES[2];

// The slices this unit is blocked by, used by the FR-020 failure-output
// contract to attribute a divergence to an owning slice. The journey-to-slice
// mapping is by requirement and story overlap, so each step names a
// conservative superset.
const SLICE = {
  declare: { title: "Declare a choice probe on a configuration field" },
  runner: { title: "One host-executed probe runner with a parse-mode registry" },
  serve: { title: "Serve probed choices through the existing choice path" },
  notify: { title: "Add the file-registered, stdin-payload notification variant" },
  compat: { title: "Prove both additions are non-breaking and agent-agnostic" },
  sdk: { title: "Publish the SDK carrying both contract additions" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction:
      "Install an agent plugin whose manifest declares a choice probe on one configuration field.",
    owners: [SLICE.declare, SLICE.sdk, SLICE.compat, SLICE.notify],
  },
  S002: {
    id: "S002",
    instruction: "Open the AI Agents settings screen for that plugin.",
    owners: [SLICE.runner, SLICE.serve],
  },
  S003: {
    id: "S003",
    instruction: "Wait for the probe to resolve.",
    owners: [SLICE.runner, SLICE.serve],
  },
  S004: {
    id: "S004",
    instruction: "Select one choice and save.",
    owners: [SLICE.serve, SLICE.compat],
  },
};

type ProbeState = "loading" | "resolved" | "failed";

interface AgentSnapshot {
  id: string;
  unavailable: { reason: string } | null;
  choiceProbes?: Record<string, { state: ProbeState }>;
}

/** The overlay as the real agent inventory route reports it, if it is listed. */
async function readAgent(request: APIRequestContext): Promise<AgentSnapshot | undefined> {
  const res = await request.get("/api/agents");
  if (res.status() !== 200) return undefined;
  const body = (await res.json()) as { agents: AgentSnapshot[] };
  return body.agents.find((a) => a.id === PLUGIN_ID);
}

/** The probed field's state, or `undefined` while the agent is not available. */
async function readProbeState(request: APIRequestContext): Promise<ProbeState | undefined> {
  const agent = await readAgent(request);
  if (!agent || agent.unavailable !== null) return undefined;
  return agent.choiceProbes?.[FIELD]?.state;
}

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);
});

test.afterEach(async ({ request }) => {
  // A slow run still in flight would write its outcome into the probe cache
  // AFTER the next reset cleared it, and hand the next test this test's state.
  await expect
    .poll(() => readProbeState(request), { timeout: PROBE_SETTLE_TIMEOUT_MS })
    .not.toBe("loading");
  // App-level agent defaults outlive /test/__reset, so drop the one S004 saved.
  await clearAgentConfig(request, PLUGIN_ID);
  await disablePlugin(request, PLUGIN_ID);
  clearProbeMode();
});

test(
  "APCC-TC-002: a declared choice probe populates a configuration field end to end (S001-S004)",
  { tag: "@APCC-TC-002" },
  async ({ page, request }) => {
    // --- S001: install the probe-declaring agent plugin; it loads ------------
    // `slow` holds the field in `loading` for 4.5 s after the first warm, which
    // the inventory read below kicks off once the agent resolves.
    setProbeMode("slow");
    await enablePlugin(request, PLUGIN_ID);
    await consentAgent(request, PLUGIN_ID);

    // A TOLERATED poll, not an assertion: a plugin that never loads has to fail
    // through `observe` so the FR-020 block names S001 and its owning slices.
    let agent: AgentSnapshot | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      agent = await readAgent(request);
      if (agent?.unavailable === null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    observe(
      STEPS.S001,
      "S001-O01",
      agent !== undefined &&
        agent.unavailable === null &&
        agent.choiceProbes?.[FIELD] !== undefined,
      `the ${PLUGIN_ID} agent is listed, available, and reports a choice probe on ${FIELD}`,
      agent === undefined
        ? "the agent is not listed"
        : `unavailable=${agent.unavailable?.reason ?? "null"}, choiceProbes=${JSON.stringify(agent.choiceProbes ?? null)}`,
    );

    // A saved default would pre-select a choice and make S004's save a no-op, so
    // start every run from an empty record (NFR-018).
    await clearAgentConfig(request, PLUGIN_ID);

    // --- S002: the AI Agents screen renders; the probed field is loading -----
    const settingsRes = await page.goto(SETTINGS_PATH);
    expect(settingsRes?.status(), `GET ${SETTINGS_PATH}`).toBe(200);
    const card = page.getByTestId(`agent-plugin-card-${PLUGIN_ID}`);
    const field = card.getByTestId(`config-field-${FIELD}`);
    await card.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const cardCount = await card.count();
    observe(
      STEPS.S002,
      "S002-O01",
      cardCount === 1,
      `the AI Agents screen renders the ${PLUGIN_ID} card`,
      `card count=${cardCount}`,
    );

    // Read promptly: the slow probe resolves 4.5 s after its warm and the screen
    // polls while a field loads, so this is the window the loading state is in.
    const loadingState = await field
      .getAttribute("data-probe-state", { timeout: 5_000 })
      .catch(() => null);
    const loadingStatus = await field
      .getByRole("status")
      .textContent({ timeout: 2_000 })
      .then((text) => text?.trim() ?? null)
      .catch(() => null);
    observe(
      STEPS.S002,
      "S002-O02",
      loadingState === "loading" && loadingStatus === "Reading the available choices from the CLI.",
      'the probed field reads data-probe-state="loading" and announces "Reading the available choices from the CLI."',
      `data-probe-state=${loadingState ?? "absent"}, status=${JSON.stringify(loadingStatus)}`,
    );

    // --- S003: the probe resolves; the field lists its choices by label ------
    // Tolerated wait for the field to settle into a choice list; S003-O01 reports
    // a probe that never resolves with its expected-vs-actual.
    await expect(field)
      .not.toHaveAttribute("data-probe-state", { timeout: PROBE_SETTLE_TIMEOUT_MS })
      .catch(() => {});
    const settledState = await field.getAttribute("data-probe-state").catch(() => null);

    // React Aria's Select portals its ListBox to the document body, so the
    // options are read at page level once the trigger opens it.
    let optionTexts: string[] = [];
    if (settledState === null) {
      await field.locator("button").click();
      const options = page.getByRole("listbox").getByRole("option");
      await options
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => {});
      optionTexts = (await options.allTextContents()).map((text) => text.trim());
    }
    const expectedLabels = PROBED_CHOICES.map((choice) => choice.label);
    observe(
      STEPS.S003,
      "S003-O01",
      JSON.stringify(optionTexts) === JSON.stringify(expectedLabels),
      `the field lists the probe's ${PROBED_CHOICES.length} choices: ${expectedLabels.join(", ")}`,
      settledState === null
        ? `options=${JSON.stringify(optionTexts)}`
        : `the field never resolved: data-probe-state=${settledState}`,
    );

    const rawIdentifiers = PROBED_CHOICES.map((choice) => choice.value as string);
    const shownRaw = optionTexts.filter((text) =>
      rawIdentifiers.some((value) => text.includes(value)),
    );
    observe(
      STEPS.S003,
      "S003-O02",
      optionTexts.length > 0 && shownRaw.length === 0,
      "each choice shows its label, never its raw identifier",
      optionTexts.length === 0
        ? "no choices were listed"
        : `options showing a raw identifier=${JSON.stringify(shownRaw)}`,
    );

    // --- S004: select one choice and save; the identifier persists -----------
    await page.getByRole("option", { name: PICK.label, exact: true }).click();
    const save = page.getByTestId(`agent-config-save-${PLUGIN_ID}`);
    await expect(save, "Save defaults is enabled once the draft diverges").toBeEnabled();
    await save.click();
    // Tolerated wait: "Saved." is how long to wait for the round trip. The
    // observations below read the persisted record back through the real API.
    await page
      .getByTestId(`agent-config-form-${PLUGIN_ID}`)
      .getByText("Saved.")
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => {});

    // The selection persists across a reload of the screen, not only in the
    // form's own optimistic state.
    await page.reload();
    await field.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    const reloadedText = (
      (await field
        .locator("button")
        .textContent()
        .catch(() => null)) ?? ""
    ).trim();
    const persisted = await readAgentConfig(request, PLUGIN_ID);
    observe(
      STEPS.S004,
      "S004-O01",
      persisted[FIELD] !== undefined && reloadedText === PICK.label,
      `after a reload the field still shows "${PICK.label}" and the saved record carries ${FIELD}`,
      `field shows ${JSON.stringify(reloadedText)}, persisted config=${JSON.stringify(persisted)}`,
    );

    observe(
      STEPS.S004,
      "S004-O02",
      persisted[FIELD] === PICK.value,
      `the saved ${FIELD} is the choice identifier "${PICK.value}", not its label "${PICK.label}"`,
      `persisted ${FIELD}=${JSON.stringify(persisted[FIELD])}`,
    );
  },
);
