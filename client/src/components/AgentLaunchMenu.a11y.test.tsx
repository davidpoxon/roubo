// @vitest-environment jsdom
//
// AP-TC-054 / AP-NFR-005: the Terminal split-button launch menu is opened,
// walked, activated and dismissed with the keyboard alone, its three groups
// carry names an assistive technology can announce, and the open menu scans
// clean.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { Button, MenuTrigger } from "react-aria-components";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import AgentLaunchMenu from "./AgentLaunchMenu";
import { resolveLaunchTarget } from "./settings/agents/agent-launchability";
import { expectNoAxeFindings } from "../test/axe";

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

const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  appDefaults: { model: "opus" },
  overrides: {},
  effective: { model: "opus" },
  unavailable: null,
  misconfigured: null,
};

const CODEX: ProjectAgentState = {
  id: "codex-cli",
  name: "Codex CLI",
  appDefaults: {},
  overrides: {},
  effective: { reasoningEffort: "medium" },
  unavailable: null,
  misconfigured: null,
};

const onLaunchPreset = vi.fn();
const onLaunchAgent = vi.fn();
const onLaunchWithOverrides = vi.fn();

/**
 * The split-button as the Terminal tab wires it: a primary segment that
 * launches, and the chevron that opens this menu. Both are present so the
 * chevron's own accessible name (AP-TC-054 S001-O01) is asserted against a
 * genuine sibling rather than a lone button.
 */
function renderSplitButton() {
  const agents = [CLAUDE, CODEX];
  renderWithProviders(
    <>
      <Button aria-label="Launch Agent">Agent</Button>
      <MenuTrigger>
        <Button aria-label="Choose launch option" />
        <AgentLaunchMenu
          presets={[BUILTIN_AGENT, APP_TOOL]}
          agents={agents}
          resolveTarget={(preset) => resolveLaunchTarget(preset, agents, undefined)}
          onLaunchPreset={onLaunchPreset}
          onLaunchAgent={onLaunchAgent}
          onLaunchWithOverrides={onLaunchWithOverrides}
        />
      </MenuTrigger>
    </>,
  );
}

beforeEach(() => {
  onLaunchPreset.mockClear();
  onLaunchAgent.mockClear();
  onLaunchWithOverrides.mockClear();
});

describe("AgentLaunchMenu: accessibility (AP-TC-054)", () => {
  it("opens from the named chevron by keyboard alone (S001-O01)", async () => {
    const user = userEvent.setup();
    renderSplitButton();

    // Tab past the primary segment onto the chevron, exactly as a keyboard user
    // reaches it in the tab bar.
    await user.tab();
    await user.tab();
    const chevron = screen.getByRole("button", { name: "Choose launch option" });
    expect(document.activeElement).toBe(chevron);

    await user.keyboard("{Enter}");

    expect(await screen.findByRole("menu")).toBeDefined();
  });

  it("moves focus across all three groups with the arrow keys (S001-O01)", async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");

    // Enter opens onto the first item; each ArrowDown steps to the next one,
    // crossing the group boundaries rather than stopping at them.
    const walked: string[] = [];
    for (let step = 0; step < 5; step += 1) {
      walked.push(document.activeElement?.getAttribute("aria-label") ?? "");
      await user.keyboard("{ArrowDown}");
    }

    expect(walked).toEqual([
      "Agent: → Claude Code",
      "Fast Codex: low → Codex CLI",
      "Claude Code: opus",
      "Codex CLI: medium",
      "Launch with overrides",
    ]);
  });

  it("names each group after its heading so the grouping is conveyed (S003-O01)", async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.click(screen.getByRole("button", { name: "Choose launch option" }));
    await screen.findByRole("menu");

    // A visible header is not enough: the group has to be programmatically
    // named by it, or a screen reader announces three anonymous groups.
    for (const heading of ["Built-in · default agent", "Agent tools", "All agents"]) {
      expect(screen.getByRole("group", { name: heading })).toBeDefined();
    }
  });

  it("launches the focused item with Enter (S002-O01)", async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onLaunchPreset).toHaveBeenCalledWith(APP_TOOL);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and returns focus to the split-button (S002-O01)", async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.tab();
    await user.tab();
    const chevron = screen.getByRole("button", { name: "Choose launch option" });

    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    // React Aria restores focus on the frame after the popover unmounts, so the
    // assertion has to wait for it rather than read the same tick.
    await waitFor(() => {
      expect(document.activeElement).toBe(chevron);
    });
  });

  it("has no axe violations on the open menu (S003-O01)", async () => {
    const user = userEvent.setup();
    renderSplitButton();

    await user.click(screen.getByRole("button", { name: "Choose launch option" }));
    const menu = await screen.findByRole("menu");

    expectNoAxeFindings(await axe(menu));
  });
});
