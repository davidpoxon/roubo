import { expect, test, type Locator, type Page } from "@playwright/test";
import { makeObserve, type JourneyStep } from "../component-plugins/_support/step-runner.js";
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_PLUGIN_ID,
  CODEX_PLUGIN_ID,
  DEFAULT_AGENT_BINDING,
  consentAgent,
  disablePlugin,
  enablePlugin,
  readAppAgentTools,
  setAppAgentTools,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// Bind the FR-020 observer to this guard's case id so its divergence blocks read
// "AP-TC-025".
const observe = makeObserve("AP-TC-025");

// AP-TC-025 (#681, AP-WU-036) - E2E: the agent tool editor binds an agent, takes
// parameter overrides and a jig behaviour, and a default-agent-bound preset
// renders as "default agent -> <current default>" in its list subtitle.
//
// ONE test carries the bare id and it asserts EVERY observation of the case
// (#680). Before this spec no test carried AP-TC-025 at all.
//
// WHY A BROWSER, not jsdom. S003-O02 is a rendered string, and S002 is about
// what the editor's controls will accept, which is a property of the form as
// mounted against a REAL plugin manifest. The unit tests for AgentToolEditorModal
// supply a hand-written `configSchema`; here the schema comes from the
// claude-code overlay, which is copied verbatim from the shipping plugin's
// manifest, so the controls under test are the ones a user really sees.
//
// That is what makes S002-O01's "parameter override SELECTS" discriminating
// here. The overlay spells its choices as `oneOf: [{ const, title }]`, the way
// every shipping manifest does, so a helper that only understood a bare `enum`
// would render three free-text boxes against it and still accept the values
// written into them (the divergence issue #691 closed).

const SETTINGS_PATH = "/settings";
const PRESET_NAME = "AP-TC-025 deep work";

/** The overrides S002 sets. All three are valid values in Claude Code's schema. */
const OVERRIDES = { model: "opus", effort: "high", mode: "plan" } as const;

/**
 * The title the overlay's manifest gives each of those values
 * (e2e/fixtures/bundled-overlays/claude-code/roubo-plugin.yaml). A select
 * offering the raw const instead would be reading the schema as a bare `enum`
 * rather than as the titled choice list the manifest declares.
 */
const OVERRIDE_TITLES = { model: "Opus", effort: "High", mode: "Plan" } as const;

/** The editor's jig sentinels (shared/config-schema.ts:221-223). */
const JIG_INHERIT = "__inherit__";
const JIG_NONE = "__none__";

/**
 * The inherit entry every parameter select carries. Its value is empty because
 * the editor never writes it, which is what makes an untouched override fall
 * through to the layers beneath it (AP-TC-036 S001-O03).
 */
const INHERIT_OPTION = { value: "", label: "inherit" } as const;

// The slice issues that own this behaviour, used by the FR-020 failure-output
// contract to attribute a divergence.
const SLICE = {
  editor: { issue: 516, title: "Agent tool presets: editor, built-ins, resolution" },
  gate: { issue: 537, title: "Verify gate: Phase 2 Claude Parity & Launch Surfaces" },
} as const;

const STEPS: Record<string, JourneyStep> = {
  S001: {
    id: "S001",
    instruction: "Open the preset editor and set the Agent select to 'Default agent'",
    owners: [SLICE.editor],
  },
  S002: {
    id: "S002",
    instruction:
      "Set Model, Effort, and Mode overrides and choose a Jig value of 'Inherit (effective default)'",
    owners: [SLICE.editor],
  },
  S003: {
    id: "S003",
    instruction: "Save the preset and inspect its list entry",
    owners: [SLICE.editor, SLICE.gate],
  },
};

interface OptionEntry {
  value: string;
  label: string;
}

/** Every `<option>` of a native select, in document order. */
async function optionsOf(select: Locator): Promise<OptionEntry[]> {
  return select.evaluate((el) =>
    [...(el as HTMLSelectElement).options].map((option) => ({
      value: option.value,
      label: (option.textContent ?? "").trim(),
    })),
  );
}

interface ParamControl {
  key: string;
  /** `select` is what S002-O01 requires; `input` is the free-text fallback. */
  tag: string;
  value: string;
  /** Every option a select offers, or empty for the free-text fallback. */
  options: OptionEntry[];
}

/**
 * Write one parameter override, whichever control the editor chose to render for
 * it, and report which that was. Both branches are driven because S002-O01
 * observes WHICH control appeared as much as whether it took the value: a
 * free-text box that accepts "opus" is not the select the case asks for, so the
 * fallback has to be reachable in order to be reported.
 */
async function setParamField(page: Page, key: string, value: string): Promise<ParamControl> {
  const field = page.locator(`#agent-tool-${key}`);
  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "select") {
    await field.selectOption(value);
    return { key, tag, value: await field.inputValue(), options: await optionsOf(field) };
  }
  await field.fill(value);
  return { key, tag, value: await field.inputValue(), options: [] };
}

/** Open Settings and switch to the Jigs tab, which hosts the Agent tools list. */
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

  // Precondition: "Claude Code and Codex CLI are both installed and configured"
  // (AP-TC-025), with Claude Code pinned as the default so the binding has
  // something to resolve to. `resolveAgent` refuses an unconsented agent, so
  // without the consent calls the subtitle would read "default agent -> none".
  //
  // The SECOND agent is what makes S003-O02 discriminating. The subtitle's
  // resolved name is computed CLIENT-side (ProjectSettings.tsx, the
  // `defaultAgent` prop): the availability-gated `jigs.defaultAgentPluginId` is
  // consulted first, then it falls back to `availableAgents.length === 1 ?
  // availableAgents[0].id : null`. With one available agent, a regression that
  // dropped the pinned default entirely would still render "default agent ->
  // Claude Code" and the observation would pass anyway. With two, the pin is the
  // only thing that can produce that subtitle.
  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID]);
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);

  // App-level presets live in settings.json, which /test/__reset does not clear,
  // so a preset saved by an earlier run would still be listed and S003 could read
  // the wrong row (NFR-018).
  await setAppAgentTools(request, []);
});

test.afterEach(async ({ request }) => {
  await setAppAgentTools(request, []);
  await setDefaultAgent(request, null);
  // Hand the environment back with exactly one available agent again: the second
  // overlay is opt-in per spec, and AP-TC-087's single-available-agent fallback
  // depends on it being off.
  await disablePlugin(request, CODEX_PLUGIN_ID);
});

test("AP-TC-025: bind an agent tool to the default agent, override params, save (S001-S003)", async ({
  page,
  request,
}) => {
  await openJigsTab(page);

  // --- S001: the editor opens bound to the default agent ---------------------
  const newTool = page.getByRole("button", { name: "New agent tool" });
  await expect(newTool, "the Agent tools section offers New agent tool").toBeVisible();
  await newTool.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Agent tool" })).toBeVisible();

  const agentSelect = page.locator("#agent-tool-agent");
  // Setting it explicitly rather than trusting the default: the step is "set the
  // Agent select to 'Default agent'", and a form that happens to open on the
  // right value is not the same as one that accepts being set to it.
  await agentSelect.selectOption(DEFAULT_AGENT_BINDING);
  const agentValue = await agentSelect.inputValue();
  const agentOptions = await optionsOf(agentSelect);
  const selectedLabel = agentOptions.find((option) => option.value === agentValue)?.label ?? "";
  observe(
    STEPS.S001,
    "S001-O01",
    agentValue === DEFAULT_AGENT_BINDING &&
      selectedLabel === "Default agent" &&
      agentOptions.some((option) => option.value === CLAUDE_PLUGIN_ID),
    `the Agent select binds to '${DEFAULT_AGENT_BINDING}' ("Default agent") rather than to the ${CLAUDE_PLUGIN_ID} plugin, which is offered separately`,
    `value=${JSON.stringify(agentValue)} label=${JSON.stringify(selectedLabel)}, options=${JSON.stringify(agentOptions)}`,
  );

  // --- S002: parameter overrides and jig behaviour --------------------------
  await page.locator("#agent-tool-name").fill(PRESET_NAME);
  const model = await setParamField(page, "model", OVERRIDES.model);
  const effort = await setParamField(page, "effort", OVERRIDES.effort);
  const mode = await setParamField(page, "mode", OVERRIDES.mode);

  const jigSelect = page.locator("#agent-tool-jig");
  const jigOptions = await optionsOf(jigSelect);
  const namedJigs = jigOptions.filter(
    (option) => option.value !== JIG_INHERIT && option.value !== JIG_NONE,
  );
  await jigSelect.selectOption(JIG_INHERIT);
  const jigValue = await jigSelect.inputValue();

  // The three param controls are selects offering the bound agent's own choices
  // and they took the values written into them, and the jig select offers all
  // three kinds of jig behaviour with Inherit selected.
  const controls = [model, effort, mode];
  const paramsAccepted =
    model.value === OVERRIDES.model &&
    effort.value === OVERRIDES.effort &&
    mode.value === OVERRIDES.mode;
  // "Parameter override selects": each field is a select whose options are the
  // manifest's titled choices plus the inherit entry that leaves the field
  // falling through to the layers beneath it. A free-text box would accept the
  // same three values while offering the user none of them.
  const paramsAreChoiceSelects = controls.every(
    (control) =>
      control.tag === "select" &&
      control.options.some(
        (option) => option.value === INHERIT_OPTION.value && option.label === INHERIT_OPTION.label,
      ) &&
      control.options.some(
        (option) =>
          option.value === control.value &&
          option.label === OVERRIDE_TITLES[control.key as keyof typeof OVERRIDE_TITLES],
      ),
  );
  const jigOffersEverything =
    jigOptions.some((option) => option.value === JIG_INHERIT) &&
    namedJigs.length >= 1 &&
    jigOptions.some((option) => option.value === JIG_NONE) &&
    jigValue === JIG_INHERIT;
  observe(
    STEPS.S002,
    "S002-O01",
    paramsAccepted && paramsAreChoiceSelects && jigOffersEverything,
    `the Model, Effort and Mode overrides are selects offering inherit plus the bound agent's own titled choices (${OVERRIDE_TITLES.model} / ${OVERRIDE_TITLES.effort} / ${OVERRIDE_TITLES.mode}) and accept the override values, and the jig behavior select offers Inherit, a named jig and None`,
    `${controls
      .map(
        (control) =>
          `${control.key}=<${control.tag}> ${JSON.stringify(control.value)} options=${JSON.stringify(control.options)}`,
      )
      .join(", ")}; jig value=${JSON.stringify(jigValue)}, options=${JSON.stringify(jigOptions)}`,
  );

  // --- S003: save, then read the list entry back ----------------------------
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog, "the editor closes on save").toBeHidden();

  const row = page.getByTestId("agent-tool-row").filter({ hasText: PRESET_NAME });
  // A TOLERATED wait, not an assertion: a row that never appears leaves the
  // observations below to report the divergence with their own attribution
  // block, rather than failing here as an unattributed Playwright timeout.
  await row
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  // Read what was PERSISTED through the real API rather than trusting the list's
  // own optimistic state. An `Inherit` jig is recorded as the ABSENCE of `jig`:
  // the editor never writes the inherit sentinel, which is what makes the preset
  // follow the effective default rather than pinning today's value.
  //
  // Polled because the list updates OPTIMISTICALLY: the row is on screen before
  // the settings write lands, so a single read here would race it and report a
  // save that had simply not finished. A preset that never appears still reports
  // through the observation below, with the whole persisted list as its actual.
  let persisted: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 40 && saved === undefined; attempt += 1) {
    persisted = await readAppAgentTools(request);
    saved = persisted.find((preset) => preset.name === PRESET_NAME);
    if (saved === undefined) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  observe(
    STEPS.S003,
    "S003-O01",
    saved !== undefined &&
      saved.agent === DEFAULT_AGENT_BINDING &&
      JSON.stringify(saved.params ?? {}) === JSON.stringify(OVERRIDES) &&
      saved.jig === undefined,
    `the saved preset records agent=${DEFAULT_AGENT_BINDING}, params=${JSON.stringify(OVERRIDES)} and an inherited jig (no stored jig)`,
    saved === undefined
      ? `no preset named ${JSON.stringify(PRESET_NAME)} in ${JSON.stringify(persisted)}`
      : JSON.stringify(saved),
  );

  const binding = row.getByTestId("agent-tool-binding");
  const bindingCount = await binding.count();
  const bindingText = bindingCount === 1 ? ((await binding.textContent()) ?? "").trim() : "";
  // U+2192, the character the component renders (AgentToolsSection.tsx:71).
  const expectedBinding = `default agent → ${CLAUDE_AGENT_NAME}`;
  observe(
    STEPS.S003,
    "S003-O02",
    bindingCount === 1 && bindingText === expectedBinding,
    `the list entry's subtitle renders the binding as ${JSON.stringify(expectedBinding)}`,
    bindingCount === 1
      ? JSON.stringify(bindingText)
      : `${bindingCount} rows matched ${JSON.stringify(PRESET_NAME)}`,
  );
});
