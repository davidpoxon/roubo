// @vitest-environment jsdom
//
// AP-NFR-004: zero serious axe violations on the Agent tools section, in each
// of its states (built-ins only, a mixed list with an unresolved preset, and
// the open editor modal).

import { describe, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type {
  AgentPluginState,
  AgentToolPreset,
  JigMeta,
  ResolvedAgentPreset,
} from "@roubo/shared";
import { expectNoAxeFindings } from "../../../test/axe";

vi.mock("../../../hooks/useToast", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

vi.mock("../../../hooks/useAgentTools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useAgentTools")>();
  return { ...actual, useAgentTools: vi.fn(), useAppAgentPresets: vi.fn() };
});

import {
  useAgentTools as _useAgentTools,
  useAppAgentPresets as _useAppAgentPresets,
} from "../../../hooks/useAgentTools";
import AgentToolsSection from "./AgentToolsSection";

const mockedAgentTools = vi.mocked(_useAgentTools);
const mockedAppPresets = vi.mocked(_useAppAgentPresets);

const CLAUDE: AgentPluginState = {
  id: "claude-code",
  name: "Claude Code",
  configSchema: {
    type: "object",
    properties: { mode: { type: "string", enum: ["plan", "auto"] } },
  },
  config: {},
  unavailable: null,
};

const JIGS: JigMeta[] = [
  {
    id: "refactor-pass",
    name: "Refactor pass",
    description: "Structured refactoring",
    icon: "file-text",
    source: "app",
  } as JigMeta,
];

function setPresets(agentTools: AgentToolPreset[]) {
  mockedAgentTools.mockReturnValue({
    agentTools,
    saveAgentTool: vi.fn(),
    deleteAgentTool: vi.fn(),
    isLoading: false,
  });
}

function setResolved(presets: ResolvedAgentPreset[]) {
  mockedAppPresets.mockReturnValue({ data: { presets } } as ReturnType<typeof _useAppAgentPresets>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPresets([]);
  setResolved([]);
});

describe("AgentToolsSection: axe-core", () => {
  it("has no axe violations with only the built-in presets", async () => {
    const { container } = render(
      <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations with a mixed list including an unresolved preset", async () => {
    setPresets([
      { id: "at-1", name: "Deep work", agent: "claude-code", params: { mode: "plan" } },
      { id: "at-2", name: "Quick fix", agent: "codex-cli" },
    ]);
    const { container } = render(
      <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations with a degraded built-in marked", async () => {
    setResolved([
      {
        id: "__builtin_agent_plan__",
        name: "Agent (Plan)",
        icon: "bot",
        source: "builtin",
        agent: "default",
        bindsDefaultAgent: true,
        agentPluginId: "claude-code",
        resolvedAgentName: "Claude Code",
        params: {},
        degraded: {
          droppedParams: ["mode"],
          message:
            'Agent tool "Agent (Plan)" drops mode, which Claude Code does not accept, so it launches as a plain agent.',
        },
      },
    ]);
    const { container } = render(
      <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations in the open editor modal", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));
    expectNoAxeFindings(await axe(screen.getByRole("dialog")));
  });
});
