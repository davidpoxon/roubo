// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectAgentState } from "@roubo/shared";

vi.mock("../../hooks/useProjectAgents");

import {
  useProjectAgents as _useProjectAgents,
  useSaveProjectAgentOverride as _useSave,
} from "../../hooks/useProjectAgents";
import { AgentOverridesSection } from "./AgentOverridesSection";

const mockedList = vi.mocked(_useProjectAgents);
const mockedSave = vi.mocked(_useSave);

/** AP-TC-005 / AP-TC-010 / AP-TC-016 preconditions: model/effort/mode. */
const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  version: "1.2.0",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string", title: "Model", enum: ["sonnet", "opus", "haiku"] },
      effort: { type: "string", title: "Effort", enum: ["low", "high"] },
      mode: { type: "string", title: "Mode", enum: ["plan", "auto"] },
    },
  },
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  overrides: {},
  effective: { model: "opus", effort: "high", mode: "plan" },
  unavailable: null,
};

function listResult(agents: ProjectAgentState[], orphanedOverrides: unknown[] = []) {
  return {
    data: { agents, orphanedOverrides },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useProjectAgents>;
}

const mutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockedSave.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
    typeof _useSave
  >);
});

describe("AgentOverridesSection", () => {
  it("shows every field's app default beside its override row (AP-TC-005 S001)", () => {
    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="roubo-development" />);

    const card = within(screen.getByTestId("project-agent-card-claude-code"));
    expect(card.getByTestId("project-agent-toggle-claude-code-model")).toBeInTheDocument();
    expect(card.getByTestId("project-agent-app-default-claude-code-model")).toHaveTextContent(
      "App default: opus",
    );
    expect(card.getByTestId("project-agent-app-default-claude-code-effort")).toHaveTextContent(
      "App default: high",
    );
    expect(card.getByTestId("project-agent-app-default-claude-code-mode")).toHaveTextContent(
      "App default: plan",
    );
  });

  it("marks the un-overridden fields as inheriting (AP-TC-005 S002)", async () => {
    mockedList.mockReturnValue(listResult([{ ...CLAUDE, overrides: { model: "sonnet" } }]));
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(
      screen.queryByTestId("project-agent-inherits-claude-code-model"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("project-agent-inherits-claude-code-effort")).toHaveTextContent(
      "Inherits app default",
    );
    expect(screen.getByTestId("project-agent-inherits-claude-code-mode")).toHaveTextContent(
      "Inherits app default",
    );
  });

  it("previews the effective config as app defaults overlaid per field (AP-TC-005 S003)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          overrides: { model: "sonnet" },
          effective: { model: "sonnet", effort: "high", mode: "plan" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=sonnet, effort=high, mode=plan",
    );
  });

  it("reverts a field to the app default when its override is toggled off (AP-TC-005 S004)", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([{ ...CLAUDE, overrides: { model: "sonnet" } }]));
    render(<AgentOverridesSection projectId="roubo-development" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));

    expect(screen.getByTestId("project-agent-inherits-claude-code-model")).toBeInTheDocument();
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=opus, effort=high, mode=plan",
    );
  });

  it("saves the override subset, not a whole config", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="roubo-development" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));
    await user.click(screen.getByTestId("project-agent-save-claude-code"));

    expect(mutate).toHaveBeenCalledTimes(1);
    // Toggling a field on seeds it with the app default it replaces, and no
    // other field joins the payload.
    expect(mutate.mock.calls[0][0]).toEqual({ model: "opus" });
  });

  it("previews the fully-overridden and fully-inherited boundaries exactly (AP-TC-010)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          overrides: { model: "sonnet", effort: "low", mode: "auto" },
          effective: { model: "sonnet", effort: "low", mode: "auto" },
        },
      ]),
    );
    const { unmount } = render(<AgentOverridesSection projectId="roubo-development" />);
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=sonnet, effort=low, mode=auto",
    );
    unmount();

    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="roubo-development" />);
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=opus, effort=high, mode=plan",
    );
  });

  it("tracks an app-default change on the fields that inherit (AP-TC-010 S003)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          appDefaults: { model: "haiku", effort: "high", mode: "plan" },
          effective: { model: "haiku", effort: "high", mode: "plan" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(screen.getByTestId("project-agent-app-default-claude-code-model")).toHaveTextContent(
      "App default: haiku",
    );
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=haiku",
    );
  });

  it("holds an overridden field fixed while an inherited one tracks (AP-TC-016 S002)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          appDefaults: { model: "opus", effort: "low", mode: "plan" },
          overrides: { model: "sonnet" },
          effective: { model: "sonnet", effort: "low", mode: "plan" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=sonnet, effort=low, mode=plan",
    );
  });

  it("names an orphaned override without rendering a card for it (AP-TC-008)", () => {
    mockedList.mockReturnValue(
      listResult([CLAUDE], [{ pluginId: "ghost-agent", reason: "not-installed" }]),
    );
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(screen.getByTestId("project-agent-orphaned-overrides")).toHaveTextContent("ghost-agent");
    expect(screen.queryByTestId("project-agent-card-ghost-agent")).not.toBeInTheDocument();
    // The installed plugin's effective config is unaffected.
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=opus, effort=high, mode=plan",
    );
  });

  it("renders an empty state, not an error, with no agent plugins installed", () => {
    mockedList.mockReturnValue(listResult([]));
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(screen.getByTestId("project-agents-empty-state")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a load failure as an alert", () => {
    mockedList.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    } as unknown as ReturnType<typeof _useProjectAgents>);
    render(<AgentOverridesSection projectId="roubo-development" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load agent overrides: boom");
  });

  it("gives each installed plugin its own independent card", () => {
    const codex: ProjectAgentState = {
      id: "codex-cli",
      name: "Codex CLI",
      configSchema: {
        type: "object",
        properties: { sandbox: { type: "string", title: "Sandbox", enum: ["read-only", "write"] } },
      },
      appDefaults: { sandbox: "read-only" },
      overrides: {},
      effective: { sandbox: "read-only" },
      unavailable: null,
    };
    mockedList.mockReturnValue(listResult([CLAUDE, codex]));
    render(<AgentOverridesSection projectId="roubo-development" />);

    const claude = within(screen.getByTestId("project-agent-card-claude-code"));
    expect(claude.getByText("Model")).toBeInTheDocument();
    expect(claude.queryByText("Sandbox")).not.toBeInTheDocument();

    const codexCard = within(screen.getByTestId("project-agent-card-codex-cli"));
    expect(codexCard.getByText("Sandbox")).toBeInTheDocument();
    expect(codexCard.queryByText("Model")).not.toBeInTheDocument();
  });
});
