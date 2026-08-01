// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { AgentPluginState } from "@roubo/shared";

vi.mock("../../../hooks/useAgentPlugins");
// AgentsTab mounts the one-time upgrade notice, which reads settings. Stub the
// hook so these tests need no QueryClientProvider; the notice has its own suite.
vi.mock("../../../hooks/useSettings", () => ({
  useSettings: () => ({ settings: undefined, isLoading: false, updateSettings: vi.fn() }),
}));

import {
  useAgentPlugins as _useAgentPlugins,
  useSaveAgentConfig as _useSaveAgentConfig,
} from "../../../hooks/useAgentPlugins";
import AgentsTab from "./AgentsTab";

const mockedList = vi.mocked(_useAgentPlugins);
const mockedSave = vi.mocked(_useSaveAgentConfig);

const CLAUDE: AgentPluginState = {
  id: "claude-code",
  name: "Claude Code",
  version: "1.2.0",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string", title: "Model", enum: ["sonnet", "opus"] },
      permissionMode: { type: "string", title: "Mode", enum: ["default", "plan"] },
    },
  },
  config: {},
  unavailable: null,
};

const CODEX: AgentPluginState = {
  id: "codex-cli",
  name: "Codex CLI",
  version: "0.9.0",
  configSchema: {
    type: "object",
    properties: {
      reasoningEffort: { type: "string", title: "Reasoning effort", enum: ["low", "high"] },
      sandbox: { type: "string", title: "Sandbox", enum: ["read-only", "workspace-write"] },
    },
  },
  config: {},
  unavailable: null,
};

function listResult(agents: AgentPluginState[]) {
  return {
    data: { agents },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useAgentPlugins>;
}

beforeEach(() => {
  mockedSave.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useSaveAgentConfig>);
});

describe("AgentsTab", () => {
  it("renders a usable empty state pointing at the marketplace with zero agents (AP-TC-012)", () => {
    mockedList.mockReturnValue(listResult([]));
    render(<AgentsTab />);

    expect(screen.getByTestId("agents-empty-state")).toBeInTheDocument();
    expect(screen.getByText("No agent plugins installed yet.")).toBeInTheDocument();
    expect(screen.getByText("Marketplace")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders one card per installed agent plugin", () => {
    mockedList.mockReturnValue(listResult([CLAUDE, CODEX]));
    render(<AgentsTab />);

    expect(screen.getByTestId("agent-plugin-card-claude-code")).toBeInTheDocument();
    expect(screen.getByTestId("agent-plugin-card-codex-cli")).toBeInTheDocument();
    expect(screen.queryByTestId("agents-empty-state")).not.toBeInTheDocument();
  });

  it("drives each card's form from that plugin's own schema (AP-TC-004)", () => {
    mockedList.mockReturnValue(listResult([CLAUDE, CODEX]));
    render(<AgentsTab />);

    const claude = within(screen.getByTestId("agent-plugin-card-claude-code"));
    expect(claude.getByText("Model")).toBeInTheDocument();
    expect(claude.getByText("Mode")).toBeInTheDocument();
    expect(claude.queryByText("Reasoning effort")).not.toBeInTheDocument();

    const codex = within(screen.getByTestId("agent-plugin-card-codex-cli"));
    expect(codex.getByText("Reasoning effort")).toBeInTheDocument();
    expect(codex.getByText("Sandbox")).toBeInTheDocument();
    expect(codex.queryByText("Model")).not.toBeInTheDocument();
  });

  it("gives every plugin its own independent form, at six installed agents (AP-TC-015)", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...CLAUDE,
      id: `agent-${i}`,
      name: `Agent ${i}`,
      configSchema: {
        type: "object",
        properties: { [`field${i}`]: { type: "string", title: `Field ${i}` } },
      },
    }));
    mockedList.mockReturnValue(listResult(many));
    render(<AgentsTab />);

    for (let i = 0; i < 6; i++) {
      const card = within(screen.getByTestId(`agent-plugin-card-agent-${i}`));
      expect(card.getByText(`Field ${i}`)).toBeInTheDocument();
      expect(card.getByTestId(`agent-config-form-agent-${i}`)).toBeInTheDocument();
    }
    expect(screen.getAllByTestId(/^agent-config-form-/)).toHaveLength(6);
  });

  it("keeps an unavailable agent visible with its blocker named", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          unavailable: { reason: "not-consented", message: "Acknowledge its permissions first." },
        },
      ]),
    );
    render(<AgentsTab />);

    expect(screen.getByTestId("agent-unavailable-claude-code")).toHaveTextContent(
      "Acknowledge its permissions first.",
    );
  });

  it("surfaces a load failure as an alert", () => {
    mockedList.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    } as unknown as ReturnType<typeof _useAgentPlugins>);
    render(<AgentsTab />);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load agents: boom");
  });
});
