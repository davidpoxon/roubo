// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, act, fireEvent } from "@testing-library/react";
import { Button, MenuTrigger } from "react-aria-components";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import AgentLaunchMenu from "./AgentLaunchMenu";
import { resolveLaunchTarget } from "./settings/agents/agent-launchability";

const BUILTIN_AGENT: ResolvedAgentPreset = {
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

const BUILTIN_PLAN: ResolvedAgentPreset = {
  ...BUILTIN_AGENT,
  id: "__builtin_agent_plan__",
  name: "Agent (Plan)",
  params: { mode: "plan" },
};

/**
 * A built-in whose `mode` the resolved agent's schema rejected, so the host
 * dropped it and the preset launches as plain `Agent` (issue #665). Advisory,
 * so it carries no `unresolved`.
 */
const BUILTIN_PLAN_DEGRADED: ResolvedAgentPreset = {
  ...BUILTIN_PLAN,
  params: {},
  degraded: {
    droppedParams: ["mode"],
    message:
      'Agent tool "Agent (Plan)" drops mode, which Claude Code does not accept, so it launches as a plain agent.',
  },
};

const APP_TOOL: ResolvedAgentPreset = {
  id: "at-fast",
  name: "Fast Codex",
  icon: "bot",
  source: "app",
  agent: "codex-cli",
  bindsDefaultAgent: false,
  agentPluginId: "codex-cli",
  resolvedAgentName: "Codex CLI",
  params: { reasoningEffort: "low" },
};

const BROKEN_PROJECT_TOOL: ResolvedAgentPreset = {
  id: "project:Ghost",
  name: "Ghost",
  icon: "bot",
  source: "project",
  agent: "ghost-agent",
  bindsDefaultAgent: false,
  params: {},
  unresolved: {
    reason: "agent-unavailable",
    message: 'Agent tool "Ghost": Agent plugin "ghost-agent" is not installed.',
  },
};

const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  overrides: {},
  effective: { model: "opus", effort: "high", mode: "plan" },
  unavailable: null,
  misconfigured: null,
};

const CODEX_UNCONFIGURED: ProjectAgentState = {
  id: "codex-cli",
  name: "Codex CLI",
  appDefaults: {},
  overrides: {},
  effective: {},
  unavailable: null,
  misconfigured: { message: "apiKey: must have required property 'apiKey'" },
};

const CODEX_CONFIGURED: ProjectAgentState = {
  ...CODEX_UNCONFIGURED,
  effective: { reasoningEffort: "medium" },
  misconfigured: null,
};

/** The agent the built-in presets bind, installed but not yet configured. */
const CLAUDE_UNCONFIGURED: ProjectAgentState = {
  ...CLAUDE,
  effective: {},
  misconfigured: { message: "apiKey: must have required property 'apiKey'" },
};

const onLaunchPreset = vi.fn();
const onLaunchAgent = vi.fn();
const onLaunchWithOverrides = vi.fn();

function open({
  presets = [BUILTIN_AGENT, BUILTIN_PLAN, APP_TOOL, BROKEN_PROJECT_TOOL],
  agents = [CLAUDE, CODEX_CONFIGURED],
}: { presets?: ResolvedAgentPreset[]; agents?: ProjectAgentState[] } = {}) {
  renderWithProviders(
    <MenuTrigger>
      <Button aria-label="Choose launch option" />
      <AgentLaunchMenu
        presets={presets}
        agents={agents}
        // The real owner threads the launch's jig through here; these cases
        // exercise the menu itself, so no jig binds an agent.
        resolveTarget={(preset) => resolveLaunchTarget(preset, agents, undefined)}
        onLaunchPreset={onLaunchPreset}
        onLaunchAgent={onLaunchAgent}
        onLaunchWithOverrides={onLaunchWithOverrides}
      />
    </MenuTrigger>,
  );
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
  });
}

/** The menu's visible text, so section order can be read as written. */
function menuText(): string {
  return screen.getByRole("menu").textContent ?? "";
}

describe("AgentLaunchMenu", () => {
  beforeEach(() => {
    onLaunchPreset.mockClear();
    onLaunchAgent.mockClear();
    onLaunchWithOverrides.mockClear();
  });

  it("renders the three groups in order with the overrides action below them (AP-TC-043)", () => {
    open();

    const text = menuText();
    const builtin = text.indexOf("Built-in · default agent");
    const tools = text.indexOf("Agent tools");
    const all = text.indexOf("All agents");
    const overrides = text.indexOf("Launch with overrides");

    expect(builtin).toBeGreaterThanOrEqual(0);
    expect(tools).toBeGreaterThan(builtin);
    expect(all).toBeGreaterThan(tools);
    expect(overrides).toBeGreaterThan(all);
  });

  it("puts only items of its kind in each group (AP-TC-043 S001-O02)", () => {
    open();

    const groups = screen.getAllByRole("group");
    const names = groups.map((group) =>
      Array.from(group.querySelectorAll('[role="menuitem"]')).map(
        (item) => (item.getAttribute("aria-label") ?? "").split(":")[0],
      ),
    );

    expect(names[0]).toEqual(["Agent", "Agent (Plan)"]);
    expect(names[1]).toEqual(["Fast Codex", "Ghost"]);
    expect(names[2]).toEqual(["Claude Code", "Codex CLI"]);
  });

  it("offers one launchable entry per configured agent with its param summary (AP-TC-023)", () => {
    open();

    const entries = screen.getAllByTestId("launch-agent-item");
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.getAttribute("aria-disabled") !== "true")).toBe(true);
    expect(entries[0].textContent).toContain("opus · high · plan");
    expect(entries[1].textContent).toContain("medium");
  });

  it("launches the agent an All-agents entry names", () => {
    open();

    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Claude Code:/ }));
    });

    expect(onLaunchAgent).toHaveBeenCalledWith(CLAUDE);
  });

  it("does not offer an installed-but-unconfigured agent as launchable (AP-TC-038)", () => {
    open({ agents: [CLAUDE, CODEX_UNCONFIGURED] });

    const codex = screen.getByRole("menuitem", { name: /^Codex CLI:/ });
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    expect(codex.textContent).toContain("configure first");

    act(() => {
      fireEvent.click(codex);
    });
    expect(onLaunchAgent).not.toHaveBeenCalled();

    // The configured agent beside it is still offered (AP-TC-038 S001-O01).
    expect(
      screen.getByRole("menuitem", { name: /^Claude Code:/ }).getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  // A built-in preset overrides no params, and preset resolution only validates
  // the keys a preset actually sets, so nothing upstream marks it unresolved
  // when the agent behind it is unconfigured. The menu has to gate on the agent
  // itself or AP-TC-038 holds for the All-agents row and leaks via the preset.
  it("disables a preset whose agent is installed but unconfigured (AP-TC-038)", () => {
    open({ agents: [CLAUDE_UNCONFIGURED, CODEX_CONFIGURED] });

    const builtin = screen.getByRole("menuitem", { name: /^Agent:/ });
    expect(builtin.getAttribute("aria-disabled")).toBe("true");
    expect(builtin.textContent).toContain("configure first");

    act(() => {
      fireEvent.click(builtin);
    });
    expect(onLaunchPreset).not.toHaveBeenCalled();

    // A preset bound to a configured agent is untouched by its neighbour.
    expect(
      screen.getByRole("menuitem", { name: /^Fast Codex:/ }).getAttribute("aria-disabled"),
    ).not.toBe("true");
  });

  // Issue #665: the degrade is advisory. The row must say the preset will not
  // do what its name promises, and must still launch when picked.
  it("notes a degraded preset's dropped params while leaving it selectable", () => {
    open({ presets: [BUILTIN_AGENT, BUILTIN_PLAN_DEGRADED] });

    const plan = screen.getByRole("menuitem", { name: /^Agent \(Plan\):/ });
    expect(plan.getAttribute("aria-disabled")).not.toBe("true");
    expect(plan.textContent).toContain("drops mode");
    expect(plan.getAttribute("aria-label")).toContain("launches as a plain agent");
    // The notice is not the amber blocker chip the disabled rows carry.
    expect(plan.textContent).not.toContain("unavailable");

    // A healthy sibling keeps its ordinary param summary.
    expect(
      screen
        .getByRole("menuitem", { name: /^Agent:/ })
        .querySelector('[data-testid="preset-degraded-notice"]'),
    ).toBeNull();

    act(() => {
      fireEvent.click(plan);
    });
    expect(onLaunchPreset).toHaveBeenCalledWith(BUILTIN_PLAN_DEGRADED);
  });

  it("disables an unresolved preset rather than launching it", () => {
    open();

    const ghost = screen.getByRole("menuitem", { name: /^Ghost:/ });
    expect(ghost.getAttribute("aria-disabled")).toBe("true");

    act(() => {
      fireEvent.click(ghost);
    });
    expect(onLaunchPreset).not.toHaveBeenCalled();
  });

  it("launches the preset a built-in entry names", () => {
    open();

    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Agent \(Plan\):/ }));
    });

    expect(onLaunchPreset).toHaveBeenCalledWith(BUILTIN_PLAN);
  });

  it("opens the per-launch override dialog from the overrides action (#518)", () => {
    open();

    const overrides = screen.getByRole("menuitem", { name: /Launch with overrides/ });
    expect(overrides.getAttribute("aria-disabled")).not.toBe("true");

    act(() => {
      fireEvent.click(overrides);
    });
    expect(onLaunchWithOverrides).toHaveBeenCalledTimes(1);
  });

  // The dialog can only offer launchable agents, so with none of them launchable
  // the action would open onto an empty picker (AP-TC-038).
  it("disables the overrides action when no agent can launch", () => {
    open({ agents: [CLAUDE_UNCONFIGURED, CODEX_UNCONFIGURED] });

    const overrides = screen.getByRole("menuitem", { name: /Launch with overrides/ });
    expect(overrides.getAttribute("aria-disabled")).toBe("true");

    act(() => {
      fireEvent.click(overrides);
    });
    expect(onLaunchWithOverrides).not.toHaveBeenCalled();
  });
});
