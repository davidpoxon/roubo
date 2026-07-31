// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import LaunchOverridesDialog from "./LaunchOverridesDialog";
import { resolveLaunchTarget, type LaunchTarget } from "./settings/agents/agent-launchability";

// The per-launch override dialog (AP-TC-029, AP-TC-034, AP-TC-046, issue #518),
// including its preset picker (issue #668).
//
// The preset targets are resolved through the real `resolveLaunchTarget`, the
// same function the launch menu is handed, so a case here cannot pass against a
// resolution the menu would disagree with.

const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  configSchema: {
    properties: {
      model: { enum: ["opus", "sonnet", "haiku"] },
      effort: { enum: ["high", "xhigh", "max"] },
      mode: { enum: ["plan", "auto"] },
    },
  },
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  overrides: { model: "sonnet" },
  effective: { model: "sonnet", effort: "high", mode: "plan" },
  unavailable: null,
  misconfigured: null,
};

const CODEX: ProjectAgentState = {
  id: "codex-cli",
  name: "Codex CLI",
  configSchema: { properties: { model: { enum: ["gpt-5.2-codex"] } } },
  appDefaults: { model: "gpt-5.2-codex" },
  overrides: {},
  effective: { model: "gpt-5.2-codex" },
  unavailable: null,
  misconfigured: null,
};

const UNCONFIGURED: ProjectAgentState = {
  ...CODEX,
  misconfigured: { message: "apiKey: must have required property 'apiKey'" },
};

/** A preset bound to Claude Code that contributes the third layer. */
const MAX_EFFORT_PRESET: ResolvedAgentPreset = {
  id: "at-deep",
  name: "Deep work",
  icon: "bot",
  source: "app",
  agent: "claude-code",
  bindsDefaultAgent: false,
  agentPluginId: "claude-code",
  resolvedAgentName: "Claude Code",
  params: { effort: "max" },
};

/** A named preset bound to the other agent, so switching preset switches agent. */
const CODEX_PRESET: ResolvedAgentPreset = {
  id: "at-codex",
  name: "Codex sweep",
  icon: "bot",
  source: "app",
  agent: "codex-cli",
  bindsDefaultAgent: false,
  agentPluginId: "codex-cli",
  resolvedAgentName: "Codex CLI",
  params: { model: "gpt-5.2-codex" },
};

/** The built-in shape: binds the default agent, overrides nothing, so a jig's own binding may redirect it. */
const DEFAULT_PRESET: ResolvedAgentPreset = {
  id: "__builtin_agent__",
  name: "Agent",
  icon: "bot",
  source: "builtin",
  agent: "default",
  bindsDefaultAgent: true,
  agentPluginId: "claude-code",
  resolvedAgentName: "Claude Code",
  params: {},
};

const onCancel = vi.fn();
const onLaunch = vi.fn();

function open({
  agents = [CLAUDE, CODEX],
  presets = [],
  initialPresetId = null,
  jigAgent,
}: {
  agents?: ProjectAgentState[];
  presets?: ResolvedAgentPreset[];
  initialPresetId?: string | null;
  /** The agent bound by the jig this launch would carry, if any. */
  jigAgent?: ProjectAgentState;
} = {}) {
  const resolveTarget = (preset: ResolvedAgentPreset): LaunchTarget =>
    resolveLaunchTarget(preset, agents, jigAgent);
  return render(
    <LaunchOverridesDialog
      isOpen
      agents={agents}
      presets={presets}
      resolveTarget={resolveTarget}
      initialPresetId={initialPresetId}
      onCancel={onCancel}
      onLaunch={onLaunch}
    />,
  );
}

function presetOptions(): HTMLOptionElement[] {
  return Array.from(screen.getByLabelText("Preset").querySelectorAll("option"));
}

function setField(key: string, value: string) {
  act(() => {
    fireEvent.change(screen.getByLabelText(new RegExp(`^${key}$`, "i")), { target: { value } });
  });
}

function traceText(): string {
  return screen.getByTestId("launch-overrides-resolution").textContent ?? "";
}

describe("LaunchOverridesDialog", () => {
  beforeEach(() => {
    onCancel.mockClear();
    onLaunch.mockClear();
  });

  it("says the launch is one-off and saves nothing", () => {
    open();
    expect(screen.getByText("One session only. Nothing is saved.")).toBeTruthy();
  });

  it("offers only agents that can actually launch", () => {
    open({ agents: [CLAUDE, UNCONFIGURED] });

    const options = Array.from(screen.getByLabelText("Agent").querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["Claude Code"]);
  });

  // The whole of AP-TC-029 in one test, so the case maps to a single suite
  // entry that covers both of its observations. The narrower tests below walk
  // the same ground a step at a time and are deliberately not tagged with this
  // case's id: a case carrying more than one id-tagged test can never be
  // corroborated from a JUnit report (#680).
  it("re-reads the selected agent's parameters, then traces this-launch edits over the layers beneath (AP-TC-029)", () => {
    open();

    // S001-O01: Claude Code declares three enums, so all three fields are
    // selects. Codex declares only `model`, so switching agent re-reads the
    // field set from the newly selected agent rather than keeping the old one.
    expect(screen.getByLabelText("Model").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Effort").tagName).toBe("SELECT");

    setField("Agent", "codex-cli");

    expect(
      Array.from(screen.getByLabelText("Model").querySelectorAll("option")).map(
        (option) => option.textContent,
      ),
    ).toEqual(["inherit", "gpt-5.2-codex"]);
    expect(screen.getByLabelText("Effort").tagName).toBe("INPUT");
    expect(traceText()).toContain("model=gpt-5.2-codex");

    // S002-O01: back on Claude Code, adjusting Model, Effort and Mode puts each
    // value on the this-launch line and supersedes the layers beneath it.
    setField("Agent", "claude-code");
    setField("Model", "haiku");
    setField("Effort", "max");
    setField("Mode", "auto");

    const perLaunch = screen.getByTestId("resolution-layer-perLaunch");
    expect(perLaunch.textContent).toContain("this launch");
    expect(perLaunch.textContent).toContain("model=haiku");
    expect(perLaunch.textContent).toContain("effort=max");
    expect(perLaunch.textContent).toContain("mode=auto");
    expect(screen.getByTestId("resolution-app-model").dataset.superseded).toBe("true");
    expect(screen.getByTestId("resolution-project-model").dataset.superseded).toBe("true");
  });

  // AP-TC-029 S001-O01 broken out step-by-step; deliberately not id-tagged (#680).
  it("re-reads the newly selected agent's parameters", () => {
    open();

    // Claude Code declares three enums, so all three fields are selects.
    expect(screen.getByLabelText("Model").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Effort").tagName).toBe("SELECT");

    setField("Agent", "codex-cli");

    // Codex declares only `model`, so Effort and Mode fall back to free text and
    // Model offers Codex's values rather than Claude's.
    const model = screen.getByLabelText("Model");
    expect(Array.from(model.querySelectorAll("option")).map((o) => o.textContent)).toEqual([
      "inherit",
      "gpt-5.2-codex",
    ]);
    expect(screen.getByLabelText("Effort").tagName).toBe("INPUT");
    expect(traceText()).toContain("model=gpt-5.2-codex");
  });

  it("drops draft values the newly selected agent does not declare", () => {
    open();

    setField("Model", "haiku");
    setField("Effort", "max");

    // Codex declares no `haiku`, so carrying it over would render a Model
    // control showing a value absent from its own options while the launch
    // still shipped it. Effort is free text on Codex, so nothing invalidates it
    // and the user's choice survives the switch.
    setField("Agent", "codex-cli");

    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Effort") as HTMLInputElement).value).toBe("max");
    expect(screen.getByTestId("resolution-layer-perLaunch").textContent).not.toContain("haiku");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(onLaunch).toHaveBeenCalledWith({
      agentPluginId: "codex-cli",
      agentName: "Codex CLI",
      perLaunchOverrides: { effort: "max" },
    });
  });

  // AP-TC-029 S002 broken out step-by-step; deliberately not id-tagged (#680).
  it("updates the trace live as fields change, emphasising this-launch values (AP-TC-046)", () => {
    open();

    // Before any edit the this-launch line contributes nothing.
    expect(screen.getByTestId("resolution-layer-perLaunch").textContent).toContain("nothing");

    setField("Model", "haiku");
    setField("Effort", "max");
    setField("Mode", "auto");

    const perLaunch = screen.getByTestId("resolution-layer-perLaunch");
    expect(perLaunch.textContent).toContain("model=haiku");
    expect(perLaunch.textContent).toContain("effort=max");
    expect(perLaunch.textContent).toContain("mode=auto");

    // The this-launch values are accent-emphasised; the layers they supersede
    // are dimmed and struck through (AP-TC-046 S001-O02).
    expect(screen.getByTestId("resolution-perLaunch-model").className).toContain("amber");
    expect(screen.getByTestId("resolution-app-model").dataset.superseded).toBe("true");
    expect(screen.getByTestId("resolution-project-model").dataset.superseded).toBe("true");
  });

  it("lists an app-default line, a project line and a this-launch line (AP-TC-046 S001-O01)", () => {
    open();

    expect(screen.getByTestId("resolution-layer-app").textContent).toContain("app default");
    expect(screen.getByTestId("resolution-layer-project").textContent).toContain("project");
    expect(screen.getByTestId("resolution-layer-perLaunch").textContent).toContain("this launch");
    // No preset contributes here, so the panel stays at three lines.
    expect(screen.queryByTestId("resolution-layer-preset")).toBeNull();
  });

  it("shows the preset layer only while the selected agent is the one it binds", () => {
    open({ presets: [MAX_EFFORT_PRESET], initialPresetId: MAX_EFFORT_PRESET.id });

    expect(screen.getByTestId("resolution-layer-preset").textContent).toContain("effort=max");

    setField("Agent", "codex-cli");
    expect(screen.queryByTestId("resolution-layer-preset")).toBeNull();
  });

  it("launches the draft as the top layer and leaves untouched fields out", () => {
    open({ presets: [MAX_EFFORT_PRESET], initialPresetId: MAX_EFFORT_PRESET.id });

    setField("Mode", "auto");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(onLaunch).toHaveBeenCalledWith({
      agentPluginId: "claude-code",
      agentName: "Claude Code",
      // Model and Effort were left on inherit, so they are absent rather than
      // sent as empty strings (AP-TC-036 S001-O03).
      perLaunchOverrides: { mode: "auto" },
      presetOverrides: { effort: "max" },
    });
  });

  // Issue #668: the dialog picks which preset feeds layer three, rather than
  // being pinned to the one preset the caller happened to pass.
  it("opens on the preset it was given and names it on the preset line", () => {
    open({ presets: [MAX_EFFORT_PRESET, CODEX_PRESET], initialPresetId: MAX_EFFORT_PRESET.id });

    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("at-deep");
    expect(screen.getByTestId("resolution-layer-preset").textContent).toContain(
      "preset: Deep work",
    );
  });

  it("switches the agent and re-bases the draft when the preset changes", () => {
    open({ presets: [MAX_EFFORT_PRESET, CODEX_PRESET], initialPresetId: MAX_EFFORT_PRESET.id });

    setField("Model", "haiku");
    setField("Effort", "max");

    setField("Preset", "at-codex");

    // The preset resolves to Codex, so the agent follows it and the fields are
    // re-based on Codex's schema exactly as an agent switch re-bases them:
    // `haiku` is not a Codex model, while Effort is free text there and survives.
    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("codex-cli");
    expect((screen.getByLabelText("Model") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Effort") as HTMLInputElement).value).toBe("max");

    const presetLayer = screen.getByTestId("resolution-layer-preset");
    expect(presetLayer.textContent).toContain("preset: Codex sweep");
    expect(presetLayer.textContent).toContain("model=gpt-5.2-codex");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(onLaunch).toHaveBeenCalledWith({
      agentPluginId: "codex-cli",
      agentName: "Codex CLI",
      perLaunchOverrides: { effort: "max" },
      presetOverrides: { model: "gpt-5.2-codex" },
    });
  });

  it("follows the agent a jig binding redirects the preset to", () => {
    // The bare built-in binds the default agent and overrides nothing, so the
    // jig's own binding wins, exactly as it does from the launch menu.
    open({ presets: [DEFAULT_PRESET], jigAgent: CODEX });

    setField("Preset", "__builtin_agent__");

    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("codex-cli");
    // It overrides nothing, so layer three still contributes no field.
    expect(screen.queryByTestId("resolution-layer-preset")).toBeNull();
  });

  it("leaves a preset whose agent cannot launch unselectable, carrying the reason", () => {
    open({
      agents: [CLAUDE, UNCONFIGURED],
      presets: [MAX_EFFORT_PRESET, CODEX_PRESET],
      initialPresetId: CODEX_PRESET.id,
    });

    const blocked = presetOptions().find((option) => option.value === "at-codex");
    expect(blocked?.disabled).toBe(true);
    // Disabled rather than dropped, so the fix stays discoverable (AP-TC-038).
    expect(blocked?.textContent).toContain("apiKey: must have required property 'apiKey'");
    expect(presetOptions().find((option) => option.value === "at-deep")?.disabled).toBe(false);

    // Opening on a blocked preset falls back to no preset rather than adopting
    // params the launch could never honour.
    expect((screen.getByLabelText("Preset") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByTestId("resolution-layer-preset")).toBeNull();
  });

  it("keeps a no-preset launch reachable", () => {
    open({ presets: [MAX_EFFORT_PRESET], initialPresetId: MAX_EFFORT_PRESET.id });

    expect(presetOptions()[0].textContent).toBe("No preset");

    setField("Preset", "");

    expect(screen.queryByTestId("resolution-layer-preset")).toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(onLaunch).toHaveBeenCalledWith({
      agentPluginId: "claude-code",
      agentName: "Claude Code",
      perLaunchOverrides: {},
    });
  });

  it("cancels without launching and without reporting a saved change (AP-TC-034 S001)", () => {
    open();

    setField("Model", "haiku");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(onLaunch).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("never mutates the agent state it was handed (AP-TC-034 S003)", () => {
    const agents = [structuredClone(CLAUDE)];
    open({ agents });

    setField("Model", "haiku");
    setField("Effort", "max");
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(agents[0].appDefaults).toEqual({ model: "opus", effort: "high", mode: "plan" });
    expect(agents[0].overrides).toEqual({ model: "sonnet" });
  });
});
