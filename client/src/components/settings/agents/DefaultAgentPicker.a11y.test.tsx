// @vitest-environment jsdom
//
// AP-TC-050 / AP-NFR-005: the Settings, Jigs default-agent picker exposes a
// radiogroup, moves selection with the arrow keys, commits with Space, and
// scans clean.
//
// Coverage gap (#703): contrast, the second half of AP-TC-050 S003-O01, is out
// of reach here. axe-core's `color-contrast` rule needs real layout, which jsdom
// does not compute, so it reports zero contrast violations even when text fails
// AA in a browser. No browser-driven check covers this surface yet; #703 tracks
// adding one, modelled on e2e/e2e-flow/spec-picker-contrast.spec.ts.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { AgentPluginState } from "@roubo/shared";
import DefaultAgentPicker from "./DefaultAgentPicker";
import { expectNoAxeFindings } from "../../../test/axe";

const CLAUDE: AgentPluginState = {
  id: "claude-code",
  name: "Claude Code",
  configSchema: {
    type: "object",
    properties: { model: { type: "string", enum: ["opus", "sonnet"] } },
  },
  config: { model: "opus" },
  unavailable: null,
};

const CODEX: AgentPluginState = {
  id: "codex-cli",
  name: "Codex CLI",
  configSchema: {
    type: "object",
    properties: { reasoningEffort: { type: "string", enum: ["low", "high"] } },
  },
  config: { reasoningEffort: "low" },
  unavailable: null,
};

function renderPicker(selected: string | null = CLAUDE.id) {
  const onChange = vi.fn();
  const utils = render(
    <DefaultAgentPicker agents={[CLAUDE, CODEX]} selectedAgentId={selected} onChange={onChange} />,
  );
  return { ...utils, onChange };
}

describe("DefaultAgentPicker: accessibility (AP-TC-050)", () => {
  it("exposes a named radiogroup of radios (S001-O01)", () => {
    renderPicker();

    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(radios.every((radio) => group.contains(radio))).toBe(true);
    // Each tile is named by the agent it selects, so the checked state is
    // announced against a name rather than a bare position in the group.
    expect(screen.getByRole("radio", { name: /Claude Code/ })).toBeDefined();
    expect(screen.getByRole("radio", { name: /Codex CLI/ })).toBeDefined();
  });

  it("moves selection with the arrow keys (S001-O01)", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker();

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Claude Code/ }));

    await user.keyboard("{ArrowDown}");

    expect(onChange).toHaveBeenCalledWith(CODEX.id);
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: /Codex CLI/ }));
  });

  it("shows a visible focus ring on the focused tile (S001-O01)", async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.tab();

    // The tile's ring is driven by React Aria's `isFocusVisible`, so a
    // keyboard-reached tile is the case that must carry it.
    const tile = screen.getByTestId(`default-agent-tile-${CLAUDE.id}`);
    expect(tile.className).toContain("ring-2");
  });

  it("commits a selection with Space alone (S002-O01)", async () => {
    const user = userEvent.setup();
    // Nothing selected yet, so Tab lands on the first radio and Space is the
    // only thing that can check it.
    const { onChange } = renderPicker(null);

    await user.tab();
    await user.keyboard(" ");

    expect(onChange).toHaveBeenCalledWith(CLAUDE.id);
  });

  it("marks the selected agent as the checked radio (S002-O01)", () => {
    renderPicker(CODEX.id);

    expect(screen.getByRole("radio", { name: /Codex CLI/ })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: /Claude Code/ })).toHaveProperty("checked", false);
  });

  it("has no axe violations (S003-O01)", async () => {
    const { container } = renderPicker();
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations in the no-configured-agents state (S003-O01)", async () => {
    const { container } = render(
      <DefaultAgentPicker agents={[]} selectedAgentId={null} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId("default-agent-empty-state")).toBeDefined();
    expectNoAxeFindings(await axe(container));
  });
});
