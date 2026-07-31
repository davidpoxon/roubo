// @vitest-environment jsdom
//
// AP-NFR-004: zero serious axe violations on the AI Agents settings screen,
// in both of its states (the zero-plugin empty state and a populated list of
// schema-driven config forms).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { AgentPluginState } from "@roubo/shared";
import { expectNoAxeFindings } from "../../../test/axe";

vi.mock("../../../hooks/useAgentPlugins");

import {
  useAgentPlugins as _useAgentPlugins,
  useSaveAgentConfig as _useSaveAgentConfig,
} from "../../../hooks/useAgentPlugins";
import AgentsTab from "./AgentsTab";

const mockedList = vi.mocked(_useAgentPlugins);
const mockedSave = vi.mocked(_useSaveAgentConfig);

const AGENTS: AgentPluginState[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.2.0",
    description: "Anthropic's terminal coding agent.",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string", title: "Model", enum: ["sonnet", "opus"] },
        maxTurns: { type: "integer", title: "Max turns" },
        verbose: { type: "boolean", title: "Verbose" },
        note: { type: "string", title: "Note" },
      },
    },
    config: { model: "opus" },
    unavailable: null,
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    version: "0.9.0",
    configSchema: {
      type: "object",
      properties: { sandbox: { type: "string", title: "Sandbox", enum: ["read-only", "write"] } },
    },
    config: {},
    unavailable: { reason: "not-consented", message: "Acknowledge its permissions first." },
  },
];

function listResult(agents: AgentPluginState[]) {
  return { data: { agents }, isLoading: false, error: null } as unknown as ReturnType<
    typeof _useAgentPlugins
  >;
}

beforeEach(() => {
  mockedSave.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<
    typeof _useSaveAgentConfig
  >);
});

describe("AgentsTab: axe-core", () => {
  it("has no axe violations with agents installed", async () => {
    mockedList.mockReturnValue(listResult(AGENTS));
    const { container } = render(<AgentsTab />);
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations in the zero-plugin empty state", async () => {
    mockedList.mockReturnValue(listResult([]));
    const { container } = render(<AgentsTab />);
    expectNoAxeFindings(await axe(container));
  });

  // AP-TC-127 S001-O01: the card's Configure/Hide control is a disclosure, so
  // its state and its target have to be programmatic. Drawn as a chevron alone,
  // a screen reader hears "Hide" with no notion that anything collapses
  // (WCAG 4.1.2).
  it("exposes the config disclosure's state and the panel it controls", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult(AGENTS));
    render(<AgentsTab />);

    const toggle = screen.getByTestId("agent-configure-claude-code");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBe("agent-config-panel-claude-code");
    expect(document.getElementById(panelId ?? "")).not.toBeNull();

    await user.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(panelId ?? "")).toBeNull();
  });

  it("has no axe violations with every card's config form collapsed", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult(AGENTS));
    const { container } = render(<AgentsTab />);

    for (const agent of AGENTS) {
      await user.click(screen.getByTestId(`agent-configure-${agent.id}`));
    }

    expectNoAxeFindings(await axe(container));
  });

  it("reaches each card's disclosure by keyboard and toggles it with Enter", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult(AGENTS));
    render(<AgentsTab />);

    const toggle = screen.getByTestId("agent-configure-claude-code");
    await user.tab();
    expect(document.activeElement).toBe(toggle);

    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("{Enter}");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
