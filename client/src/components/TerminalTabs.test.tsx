// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import TerminalTabs from "./TerminalTabs";

vi.mock("../hooks/useTerminal");
vi.mock("../hooks/useJigs");
vi.mock("../hooks/useSettings");
vi.mock("../hooks/useBenches");
vi.mock("../hooks/useToast");
vi.mock("../hooks/useAgentTools");
vi.mock("../hooks/useProjectAgents");
vi.mock("../hooks/useProjectDefaultJig");
// Stands in for the real pane, surfacing only the `waitingNotificationId` prop
// the pane strip is driven by (#1119).
vi.mock("./Terminal", () => ({
  default: ({ waitingNotificationId }: { waitingNotificationId?: string }) =>
    waitingNotificationId !== undefined ? (
      <div data-testid="pane-waiting" data-notification-id={waitingNotificationId} />
    ) : null,
}));

import type {
  AgentLaunchFailure,
  JigMeta,
  ProjectAgentState,
  ResolvedAgentPreset,
} from "@roubo/shared";
import { ApiError } from "../lib/api";
import { useTerminalSessions, useCreateTerminal, useDestroyTerminal } from "../hooks/useTerminal";
import { useJigs, useInjectJig } from "../hooks/useJigs";
import { useSettings } from "../hooks/useSettings";
import { useDismissNotification } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";
import { useAgentPresets } from "../hooks/useAgentTools";
import { useProjectAgents } from "../hooks/useProjectAgents";
import { useProjectDefaultJig } from "../hooks/useProjectDefaultJig";

const mockInjectMutate = vi.fn();
const mockCreateMutate = vi.fn();

const JIGS: JigMeta[] = [
  {
    id: "feature-dev",
    name: "Feature Dev",
    description: "",
    icon: "file-text",
    source: "app" as const,
  },
];

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

/** A preset that both overrides a param and pins "no jig" (AGENT_TOOL_JIG_NONE). */
const PLAN_PRESET: ResolvedAgentPreset = {
  ...DEFAULT_PRESET,
  id: "__builtin_agent_plan__",
  name: "Agent (Plan)",
  params: { mode: "plan" },
  jig: "__none__",
};

const CLAUDE_AGENT: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  appDefaults: {},
  overrides: {},
  effective: { model: "opus" },
  unavailable: null,
  misconfigured: null,
};

/** An agent installed and resolvable, but whose effective config does not validate. */
const UNCONFIGURED_CLAUDE: ProjectAgentState = {
  ...CLAUDE_AGENT,
  effective: {},
  misconfigured: { message: "apiKey: must have required property 'apiKey'" },
};

const CODEX_AGENT: ProjectAgentState = {
  id: "codex-cli",
  name: "Codex CLI",
  appDefaults: {},
  overrides: {},
  effective: { reasoningEffort: "medium" },
  unavailable: null,
  misconfigured: null,
};

function setupAgentMocks(
  presets: ResolvedAgentPreset[] = [DEFAULT_PRESET, PLAN_PRESET],
  agents: ProjectAgentState[] = [CLAUDE_AGENT],
  defaultJigId: string | undefined = "feature-dev",
) {
  vi.mocked(useAgentPresets).mockReturnValue({ data: { presets } } as unknown as ReturnType<
    typeof useAgentPresets
  >);
  vi.mocked(useProjectAgents).mockReturnValue({
    data: { agents, orphanedOverrides: [] },
  } as unknown as ReturnType<typeof useProjectAgents>);
  vi.mocked(useProjectDefaultJig).mockReturnValue({
    data: defaultJigId === undefined ? undefined : { jigId: defaultJigId, source: "app" },
  } as unknown as ReturnType<typeof useProjectDefaultJig>);
}

// Every describe below renders TerminalTabs, and the split-button reads both
// agent queries on every render, so they are seeded once for the whole file.
beforeEach(() => {
  setupAgentMocks();
});

function setupMocks({
  autoInject,
  isLoading = false,
}: {
  autoInject: boolean;
  isLoading?: boolean;
}) {
  vi.mocked(useTerminalSessions).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useTerminalSessions>);
  vi.mocked(useDestroyTerminal).mockReturnValue({
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useDestroyTerminal>);
  vi.mocked(useCreateTerminal).mockReturnValue({
    mutate: mockCreateMutate,
  } as unknown as ReturnType<typeof useCreateTerminal>);
  vi.mocked(useJigs).mockReturnValue({
    data: JIGS,
  } as unknown as ReturnType<typeof useJigs>);
  vi.mocked(useInjectJig).mockReturnValue({
    mutate: mockInjectMutate,
  } as unknown as ReturnType<typeof useInjectJig>);
  vi.mocked(useSettings).mockReturnValue({
    settings: isLoading
      ? undefined
      : {
          theme: "dark",
          jigs: {
            autoInject,
            autoExecute: false,
            defaultJigId: "feature-dev",
          },
        },
    isLoading,
    updateSettings: vi.fn(),
  } as unknown as ReturnType<typeof useSettings>);
  vi.mocked(useDismissNotification).mockReturnValue({
    mutate: vi.fn(),
  } as unknown as ReturnType<typeof useDismissNotification>);
  vi.mocked(useToast).mockReturnValue({
    addToast: vi.fn(),
    removeToast: vi.fn(),
  });
}

describe("TerminalTabs: agent launch and jig resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    mockInjectMutate.mockClear();
    mockCreateMutate.mockClear();
    mockCreateMutate.mockImplementation(
      (_vars, options: { onSuccess?: (r: { sessionId: string }) => void }) => {
        options?.onSuccess?.({ sessionId: "session-abc" });
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SESSION = [
    {
      id: "existing-session",
      benchKey: "project1:1",
      label: "Claude 1",
      createdAt: "2024-01-01",
      command: "claude",
      status: "live",
    },
  ];

  it("launches the default-agent preset with the auto-injected jig and a toast (AP-TC-017)", () => {
    setupMocks({ autoInject: true });
    const addToast = vi.fn();
    vi.mocked(useToast).mockReturnValue({ addToast, removeToast: vi.fn() });

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "claude-code",
        jigId: "feature-dev",
      }),
      expect.anything(),
    );
    // The launch no longer rides the built-in `claude` command path.
    expect(mockCreateMutate.mock.calls[0][0]).not.toHaveProperty("command");
    expect(addToast).toHaveBeenCalledWith("Claude Code session started");
  });

  it("does not pass a jig when autoInject is false", () => {
    setupMocks({ autoInject: false });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code", jigId: undefined }),
      expect.anything(),
    );
    expect(mockInjectMutate).not.toHaveBeenCalled();
  });

  it("passes the GLOBAL_DEFAULT_JIG_ID sentinel when no defaultJigId is configured", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useSettings).mockReturnValue({
      settings: { theme: "dark", jigs: { autoInject: true, autoExecute: false } },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "claude-code",
        jigId: "__global_default__",
      }),
      expect.anything(),
    );
  });

  it("does not pass a jig when the bench has no assigned issue", () => {
    setupMocks({ autoInject: true });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ jigId: undefined }),
      expect.anything(),
    );
  });

  it("carries a preset's params as presetOverrides and lets its jig override auto-inject", () => {
    setupMocks({ autoInject: true });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Agent \(Plan\):/ }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "claude-code",
        presetOverrides: { mode: "plan" },
        // `__none__` beats the auto-inject baseline.
        jigId: undefined,
      }),
      expect.anything(),
    );
  });

  // Issue #518: the dialog is the producer of the transient fourth layer, so the
  // whole chain (menu action -> dialog -> mutation payload) is asserted here.
  // Without `perLaunchOverrides` reaching the request the layer the server
  // already merges would have no producer at all (AP-TC-030).
  it("carries the override dialog's draft as perLaunchOverrides", () => {
    setupMocks({ autoInject: false });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Launch with overrides/ }));
    });

    act(() => {
      fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "auto" } });
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "claude-code",
        perLaunchOverrides: { mode: "auto" },
      }),
      expect.anything(),
    );
  });

  it("sends no perLaunchOverrides when the dialog's fields are left inheriting", () => {
    setupMocks({ autoInject: false });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Launch with overrides/ }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    const payload = mockCreateMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.agentPluginId).toBe("claude-code");
    expect("perLaunchOverrides" in payload).toBe(false);
  });

  // Issue #676: the dialog launches with the bench's own jig baseline, never the
  // selected preset's jig, so its Agent select has to resolve through that same
  // baseline. Resolving through the preset's jig instead would name an agent
  // bound by a jig this session never runs under.
  it("resolves the override dialog's agent through the baseline jig, not the preset's", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [
        JIGS[0],
        { ...JIGS[0], id: "codex-jig", name: "Codex Jig", agentPluginId: "codex-cli" },
      ],
    } as unknown as ReturnType<typeof useJigs>);
    const JIG_PRESET: ResolvedAgentPreset = {
      ...DEFAULT_PRESET,
      id: "at-codex-jig",
      name: "Jig Preset",
      source: "app",
      jig: "codex-jig",
    };
    setupAgentMocks([DEFAULT_PRESET, JIG_PRESET], [CLAUDE_AGENT, CODEX_AGENT]);

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });

    // The menu row DOES carry the preset's jig, so it still names Codex CLI.
    // That is what pins the two resolvers apart.
    expect(screen.getByRole("menuitem", { name: /^Jig Preset:/ }).textContent).toContain(
      "Codex CLI",
    );

    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /Launch with overrides/ }));
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "at-codex-jig" } });
    });

    expect((screen.getByLabelText("Agent") as HTMLSelectElement).value).toBe("claude-code");

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /Launch session/ }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code", jigId: "feature-dev" }),
      expect.anything(),
    );
  });

  it("launches an All-agents entry directly", () => {
    setupMocks({ autoInject: false });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });
    act(() => {
      fireEvent.click(screen.getAllByTestId("launch-agent-item")[0]);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code" }),
      expect.anything(),
    );
  });

  it("launches from the tab-bar split-button when sessions exist", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: SESSION,
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code", jigId: "feature-dev" }),
      expect.anything(),
    );
  });

  // AP-TC-054 S001-O01: both split-button segments suppress the native outline,
  // so each has to draw its own indicator or a keyboard user reaching the launch
  // control sees nothing at all (WCAG 2.4.7).
  it("gives both split-button segments a visible keyboard focus indicator", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: SESSION,
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    for (const name of ["Launch Claude Code", "Choose launch option"]) {
      expect(screen.getByRole("button", { name }).className).toContain("focus-visible:ring-2");
    }
  });

  // AP-FR-006: a jig's own agent binding beats the DEFAULT agent. The host
  // applies that order only when the request names no agent, and every launch
  // from this surface names one, so the surface has to apply it. Without this
  // an auto-injected jig bound to another agent silently launches the default.
  it("lets the auto-injected jig's own agent binding beat the default agent", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "codex-cli" }],
    } as unknown as ReturnType<typeof useJigs>);
    setupAgentMocks(undefined, [CLAUDE_AGENT, CODEX_AGENT]);
    const addToast = vi.fn();
    vi.mocked(useToast).mockReturnValue({ addToast, removeToast: vi.fn() });

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Codex CLI" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "codex-cli", jigId: "feature-dev" }),
      expect.anything(),
    );
    expect(addToast).toHaveBeenCalledWith("Codex CLI session started");
  });

  // The sentinel is the only reason `useProjectDefaultJig` is read at all: the
  // baseline jig id can be `__global_default__`, which only the host expands,
  // so without expanding it here the jig's binding is invisible and the launch
  // silently reverts to the default agent.
  it("expands the GLOBAL_DEFAULT_JIG_ID sentinel to read that jig's agent binding", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useSettings).mockReturnValue({
      settings: { theme: "dark", jigs: { autoInject: true, autoExecute: false } },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "codex-cli" }],
    } as unknown as ReturnType<typeof useJigs>);
    setupAgentMocks(undefined, [CLAUDE_AGENT, CODEX_AGENT], "feature-dev");

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Codex CLI" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "codex-cli", jigId: "__global_default__" }),
      expect.anything(),
    );
  });

  // A preset's params are validated host-side against the agent the preset
  // resolves to, and nothing re-validates them at launch, so redirecting a
  // param-bearing preset would ship `mode` to an agent whose schema never saw
  // it. Only the bare, override-free preset follows the jig.
  it("keeps a preset that overrides params on the agent those params were validated against", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "codex-cli" }],
    } as unknown as ReturnType<typeof useJigs>);
    setupAgentMocks(
      [DEFAULT_PRESET, { ...PLAN_PRESET, jig: undefined }],
      [CLAUDE_AGENT, CODEX_AGENT],
    );

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Agent \(Plan\):/ }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "claude-code",
        presetOverrides: { mode: "plan" },
      }),
      expect.anything(),
    );
  });

  // A `roubo.yaml` agent tool may name an explicit plugin and no params at all
  // (config-schema requires `agent`, leaves `params` optional), so the redirect
  // has to gate on the binding as well as on the params. That author picked an
  // agent on purpose and a jig does not get to overrule it.
  it("keeps a preset pinned to a specific agent on that agent, jig binding notwithstanding", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "codex-cli" }],
    } as unknown as ReturnType<typeof useJigs>);
    setupAgentMocks(
      [
        DEFAULT_PRESET,
        {
          ...DEFAULT_PRESET,
          id: "at-pinned",
          name: "Pinned Claude",
          source: "app",
          agent: "claude-code",
          bindsDefaultAgent: false,
        },
      ],
      [CLAUDE_AGENT, CODEX_AGENT],
    );

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: /^Pinned Claude:/ }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code" }),
      expect.anything(),
    );
  });

  // The menu row and the split-button must never disagree: the row reads the
  // same resolved target the button does, so a jig-redirected preset renders
  // enabled here exactly when the button beside it is enabled.
  it("shows the redirected agent on the preset row, matching the split-button", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "codex-cli" }],
    } as unknown as ReturnType<typeof useJigs>);
    setupAgentMocks(undefined, [UNCONFIGURED_CLAUDE, CODEX_AGENT]);

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    // The default agent is unconfigured, but the jig redirects to a healthy
    // one, so both surfaces are live rather than the row saying otherwise.
    expect(screen.getByRole("button", { name: "Launch Codex CLI" })).not.toBeDisabled();

    act(() => {
      fireEvent.click(screen.getAllByRole("button", { name: "Choose launch option" })[0]);
    });

    const row = screen.getByRole("menuitem", { name: /^Agent:/ });
    expect(row.getAttribute("aria-disabled")).not.toBe("true");
    expect(row.textContent).toContain("Codex CLI");
  });

  it("falls back to the default agent when the jig binds an agent that is not installed", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "ghost-agent" }],
    } as unknown as ReturnType<typeof useJigs>);

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Launch Claude Code" }));
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code" }),
      expect.anything(),
    );
  });

  // The binding is availability-gated, not merely presence-checked: a jig
  // pointing at an agent that IS installed but does not validate must fall back
  // to the default rather than redirecting into a session that cannot start.
  it("falls back to the default agent when the jig binds an installed but unconfigured agent", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useJigs).mockReturnValue({
      data: [{ ...JIGS[0], agentPluginId: "codex-cli" }],
    } as unknown as ReturnType<typeof useJigs>);
    setupAgentMocks(undefined, [
      CLAUDE_AGENT,
      {
        ...CODEX_AGENT,
        effective: {},
        misconfigured: { message: "apiKey: must have required property 'apiKey'" },
      },
    ]);

    renderWithProviders(
      <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />,
    );

    const primary = screen.getByRole("button", { name: "Launch Claude Code" });
    expect(primary).not.toBeDisabled();

    act(() => {
      fireEvent.click(primary);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code" }),
      expect.anything(),
    );
  });

  // AP-TC-038 reaches further than the All-agents rows: a preset resolves fine
  // while the agent behind it is unconfigured, because preset resolution only
  // validates the keys the preset itself sets, and every built-in sets none.
  it("refuses to launch when the default agent is installed but unconfigured (AP-TC-038)", () => {
    setupMocks({ autoInject: false });
    setupAgentMocks(undefined, [UNCONFIGURED_CLAUDE]);
    const addToast = vi.fn();
    vi.mocked(useToast).mockReturnValue({ addToast, removeToast: vi.fn() });

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    const primary = screen.getByRole("button", { name: "Launch Claude Code" });
    expect(primary).toBeDisabled();

    act(() => {
      fireEvent.click(primary);
    });
    expect(mockCreateMutate).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalledWith(expect.stringContaining("session started"));
  });

  it("refuses to launch when the default-agent preset is unresolved", () => {
    setupMocks({ autoInject: false });
    setupAgentMocks([
      {
        ...DEFAULT_PRESET,
        agentPluginId: undefined,
        resolvedAgentName: undefined,
        unresolved: { reason: "no-default-agent", message: "No default agent is available." },
      },
    ]);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    const primary = screen.getByRole("button", { name: "Agent" });
    act(() => {
      fireEvent.click(primary);
    });

    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("still injects a jig into a live session from the jig picker", () => {
    setupMocks({ autoInject: false });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: SESSION,
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Inject jig" }));
    });
    act(() => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Feature Dev" }));
    });

    expect(mockInjectMutate).toHaveBeenCalledWith(
      expect.objectContaining({ jigId: "feature-dev" }),
    );
    expect(mockCreateMutate).not.toHaveBeenCalled();
  });

  it("calls addToast with the error message when the launch fails", () => {
    setupMocks({ autoInject: false });
    const mockAddToast = vi.fn();
    vi.mocked(useToast).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
    });
    mockCreateMutate.mockImplementation(
      (_vars: unknown, options: { onError?: (err: Error) => void }) => {
        options?.onError?.(new Error("spawn failed: claude not found"));
      },
    );

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(mockAddToast).toHaveBeenCalledWith("spawn failed: claude not found");
  });
});

describe("TerminalTabs: notification indicators", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useJigs).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useJigs>);
    vi.mocked(useInjectJig).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectJig>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        jigs: {
          autoInject: false,
          autoExecute: false,
          defaultJigId: "feature-dev",
        },
      },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useDismissNotification).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDismissNotification>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows notification indicator on inactive tab when session has matching notification", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
        {
          id: "session-2",
          benchKey: "p:1",
          label: "Terminal 2",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-2",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // session-2 is inactive (session-1 is the first/active tab), so it should show indicator
    const session2Tab = screen.getByText("Terminal 2").closest("div");
    expect(session2Tab?.querySelector('[role="img"]')).not.toBeNull();
  });

  it("shows the waiting indicator on an agent-plugin session tab (AP-TC-065)", () => {
    // The tab indicator keys off sourceSessionId alone, with no command or
    // agent gate, so a plugin-launched agent surfaces exactly like the built-in.
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
        {
          id: "agent-session",
          benchKey: "p:1",
          label: "Acme Agent 1",
          createdAt: "2024-01-01",
          command: "acme",
          status: "live",
          agentPluginId: "acme-agent",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "agent-session",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    const agentTab = screen.getByText("Acme Agent 1").closest("div");
    expect(agentTab?.querySelector('[role="img"]')).not.toBeNull();
  });

  it("marks the ACTIVE session's pane as waiting, where the tab dot is suppressed (#1119)", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-1",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    expect(screen.getByTestId("pane-waiting")).toHaveAttribute("data-notification-id", "n1");
  });

  it("does not mark a pane as waiting for a notification that is not a waiting one", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "agent-exited" as const,
        priority: "info" as const,
        sourceSessionId: "session-1",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    expect(screen.queryByTestId("pane-waiting")).not.toBeInTheDocument();
  });

  it("does not mark a pane as waiting for another session's notification", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "terminal-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-other",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    expect(screen.queryByTestId("pane-waiting")).not.toBeInTheDocument();
  });

  it("does not show notification indicator on the active tab", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-1",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // session-1 is the only/active tab: indicator should be suppressed
    const session1Tab = screen.getByText("Terminal 1").closest("div");
    expect(session1Tab?.querySelector('[role="img"]')).toBeNull();
  });

  it("does not show notification indicator on tab when notification has different sourceSessionId", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
        {
          id: "session-2",
          benchKey: "p:1",
          label: "Terminal 2",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    const notifications = [
      {
        id: "n1",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-1",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // session-1 is active, session-2 has no matching notification
    const session2Tab = screen.getByText("Terminal 2").closest("div");
    expect(session2Tab?.querySelector('[role="img"]')).toBeNull();
  });
});

describe("TerminalTabs: agent-generic session tabs", () => {
  function setup(sessions: unknown[]) {
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useJigs).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useJigs>);
    vi.mocked(useInjectJig).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectJig>);
    vi.mocked(useSettings).mockReturnValue({
      settings: { theme: "dark", jigs: { autoInject: false, autoExecute: false } },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useDismissNotification).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDismissNotification>);
    vi.mocked(useToast).mockReturnValue({ addToast: vi.fn(), removeToast: vi.fn() });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: sessions,
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );
  }

  beforeEach(() => {
    localStorage.clear();
  });

  it("marks a plugin-launched session with its agent's colour, not a Claude-specific one", () => {
    setup([
      {
        id: "agent-session",
        benchKey: "p:1",
        label: "Acme Agent 1",
        createdAt: "2024-01-01",
        status: "live",
        agentPluginId: "codex-cli",
      },
    ]);

    const icon = screen.getByTestId("session-agent-icon");
    expect(icon.getAttribute("class")).toContain("text-cyan-400");
  });

  it("shows no agent glyph for a session whose only carrier is a command name (#521)", () => {
    setup([
      {
        id: "legacy-session",
        benchKey: "p:1",
        label: "Claude 1",
        createdAt: "2024-01-01",
        command: "claude",
        status: "live",
      },
    ]);

    // `agentPluginId` is the only carrier now. A command name never identifies
    // an agent, so no product-specific mapping survives in the client
    // (AP-TC-104).
    expect(screen.queryByTestId("session-agent-icon")).toBeNull();
  });

  it("shows no agent glyph on a plain shell session", () => {
    setup([
      {
        id: "shell-session",
        benchKey: "p:1",
        label: "Terminal 1",
        createdAt: "2024-01-01",
        command: "bash",
        status: "live",
      },
    ]);

    expect(screen.queryByTestId("session-agent-icon")).toBeNull();
  });
});

describe("TerminalTabs: tab-switch dismiss behaviour", () => {
  const mockDismissNotificationMutate = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    mockDismissNotificationMutate.mockClear();
    vi.mocked(useDismissNotification).mockReturnValue({
      mutate: mockDismissNotificationMutate,
    } as unknown as ReturnType<typeof useDismissNotification>);
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useJigs).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useJigs>);
    vi.mocked(useInjectJig).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectJig>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        jigs: {
          autoInject: false,
          autoExecute: false,
          defaultJigId: "feature-dev",
        },
      },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-a",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
        {
          id: "session-b",
          benchKey: "p:1",
          label: "Terminal 2",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("dismisses the initially-active session notifications on mount", () => {
    const notifications = [
      {
        id: "n-a",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-a",
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "n-b",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-b",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // session-a is the active tab on mount: its notification should be dismissed immediately
    expect(mockDismissNotificationMutate).toHaveBeenCalledWith({
      projectId: "proj",
      benchId: 1,
      notificationId: "n-a",
    });
    expect(mockDismissNotificationMutate).not.toHaveBeenCalledWith({
      projectId: "proj",
      benchId: 1,
      notificationId: "n-b",
    });
  });

  it("dismisses notifications for newly-active session when switching tabs", () => {
    const notifications = [
      {
        id: "n-b",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-b",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // session-a has no notification so mount does not dismiss
    mockDismissNotificationMutate.mockClear();

    act(() => {
      fireEvent.click(screen.getByText("Terminal 2"));
    });

    expect(mockDismissNotificationMutate).toHaveBeenCalledTimes(1);
    expect(mockDismissNotificationMutate).toHaveBeenCalledWith({
      projectId: "proj",
      benchId: 1,
      notificationId: "n-b",
    });
  });

  it("does not call dismiss when switching to a tab with no notifications", () => {
    // session-a has a notification; session-b has none
    const notifications = [
      {
        id: "n-a",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-a",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // Clear the mount dismissal for session-a; we only want to test the tab-click behaviour
    mockDismissNotificationMutate.mockClear();

    act(() => {
      fireEvent.click(screen.getByText("Terminal 2"));
    });

    expect(mockDismissNotificationMutate).not.toHaveBeenCalled();
  });

  it("does not re-dismiss when clicking the already-active tab", () => {
    const notifications = [
      {
        id: "n-a",
        type: "agent-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-a",
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={notifications}
      />,
    );

    // Clear mount dismissal; clicking the already-active tab should not trigger another dismiss
    mockDismissNotificationMutate.mockClear();
    act(() => {
      fireEvent.click(screen.getByText("Terminal 1"));
    });

    expect(mockDismissNotificationMutate).not.toHaveBeenCalled();
  });

  it("does not re-dismiss when notifications prop gets a new array reference (poll re-render)", () => {
    const notification = {
      id: "n-a",
      type: "agent-waiting" as const,
      priority: "action-needed" as const,
      sourceSessionId: "session-a",
      createdAt: "2024-01-01T00:00:00Z",
    };
    const { rerender } = renderWithProviders(
      <TerminalTabs
        projectId="proj"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
        notifications={[notification]}
      />,
    );

    // Clear the initial mount dismissal
    mockDismissNotificationMutate.mockClear();

    // Re-render with a new array reference containing the same notification (simulates a poll)
    act(() => {
      rerender(
        <TerminalTabs
          projectId="proj"
          benchId={1}
          projectName="Project"
          hasAssignedIssue={false}
          notifications={[{ ...notification }]}
        />,
      );
    });

    expect(mockDismissNotificationMutate).not.toHaveBeenCalled();
  });
});

describe("TerminalTabs: terminal session persistence", () => {
  function setupSessionMocks(sessions: { id: string; label: string }[]) {
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useJigs).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useJigs>);
    vi.mocked(useInjectJig).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectJig>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        jigs: {
          autoInject: false,
          autoExecute: false,
          defaultJigId: "feature-dev",
        },
      },
      isLoading: false,
      updateSettings: vi.fn(),
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useDismissNotification).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDismissNotification>);
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: sessions.map((s) => ({
        id: s.id,
        benchKey: "proj:1",
        label: s.label,
        createdAt: "2024-01-01",
        command: "bash",
        status: "live" as const,
      })),
    } as unknown as ReturnType<typeof useTerminalSessions>);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the last-clicked session after unmount and remount", () => {
    setupSessionMocks([
      { id: "session-a", label: "Terminal 1" },
      { id: "session-b", label: "Terminal 2" },
    ]);
    const { unmount } = renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    act(() => {
      fireEvent.click(screen.getByText("Terminal 2"));
    });
    unmount();

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    // Terminal 2 (session-b) should be the active tab: its container is visually distinct
    // because it has no 'hidden' class (the active tab is shown)
    const terminal2Container =
      screen.getByText("Terminal 2").closest("[data-session-id]") ??
      screen.getByText("Terminal 2").closest("div");
    expect(terminal2Container).toBeTruthy();
    // The active tab has a distinct style; assert session-b would be active by checking
    // that session-a's tab does not have the active styles (amber color)
    const terminal1Tab = screen.getByText("Terminal 1").closest("div");
    expect(terminal1Tab?.className).not.toContain("amber");
  });

  it("does not clear the persisted session id while sessions are still loading", () => {
    const STORAGE_KEY = "roubo-bench-view-state";
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ "proj:1": { activeTerminalSessionId: "session-a" } }),
    );

    // All required mocks via helper; override sessions to simulate loading state (data: undefined)
    setupSessionMocks([]);
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: undefined,
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );
    act(() => {
      vi.runAllTimers();
    });

    const store = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(store["proj:1"].activeTerminalSessionId).toBe("session-a");
  });

  it("falls back to the first available session when the persisted session no longer exists", () => {
    // First render: two sessions, click Terminal 2
    setupSessionMocks([
      { id: "session-a", label: "Terminal 1" },
      { id: "session-b", label: "Terminal 2" },
    ]);
    const { unmount } = renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );
    act(() => {
      fireEvent.click(screen.getByText("Terminal 2"));
    });
    unmount();

    // Second render: session-b is gone; only session-a remains
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-a",
          benchKey: "proj:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          command: "bash",
          status: "live" as const,
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    // Terminal 2 is gone; Terminal 1 is the only available session (fallback)
    expect(screen.queryByText("Terminal 2")).not.toBeInTheDocument();
    expect(screen.getByText("Terminal 1")).toBeInTheDocument();
  });
});

// The panel itself and the socket-side replay are covered elsewhere
// (AgentLaunchFailurePanel.test.tsx, useTerminalConnection.test.ts). What only
// this component decides is whether a refused launch becomes a panel or a toast,
// and which launch Retry replays, so that is what this block pins down.
describe("TerminalTabs: launch-failure surface", () => {
  /** A refusal from the version gate: structured, and offering both actions. */
  const BELOW_FLOOR: AgentLaunchFailure = {
    class: "below-floor-version",
    message: "Claude Code 1.0.2 is below the minimum supported 2.0.0.",
    guidance: "Update the CLI, or point the plugin at a newer install.",
    detectedVersion: "1.0.2",
    minVersion: "2.0.0",
    actions: ["open-plugin-settings", "retry"],
  };

  const REFUSAL_MESSAGE = "Agent session could not be started";

  /** The shape a refused launch actually arrives in: a 409 carrying details. */
  function apiErrorWith(launchFailure?: unknown) {
    return new ApiError(REFUSAL_MESSAGE, 409, undefined, {
      error: REFUSAL_MESSAGE,
      ...(launchFailure !== undefined && { launchFailure }),
    });
  }

  /** Reject every launch with `err`, so `onError` is the path under test. */
  function failLaunchesWith(err: unknown) {
    mockCreateMutate.mockImplementation(
      (_vars: unknown, options: { onError?: (err: unknown) => void }) => {
        options?.onError?.(err);
      },
    );
  }

  function succeedLaunches() {
    mockCreateMutate.mockImplementation(
      (_vars: unknown, options: { onSuccess?: (r: { sessionId: string }) => void }) => {
        options?.onSuccess?.({ sessionId: "session-abc" });
      },
    );
  }

  // The failure panel links to plugin settings with a react-router `Link`, so
  // this block needs a router even though the rest of the file does not.
  function renderTabs() {
    return renderWithProviders(
      <MemoryRouter>
        <TerminalTabs projectId="project1" benchId={1} projectName="Project" hasAssignedIssue />
      </MemoryRouter>,
    );
  }

  const addToast = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    addToast.mockClear();
    mockCreateMutate.mockClear();
    setupMocks({ autoInject: true });
    vi.mocked(useToast).mockReturnValue({ addToast, removeToast: vi.fn() });
    failLaunchesWith(apiErrorWith(BELOW_FLOOR));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises the failure panel, not a toast, when the refusal carries a launchFailure", () => {
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    const panel = screen.getByTestId("agent-launch-failure");
    expect(panel.getAttribute("data-failure-class")).toBe("below-floor-version");
    expect(panel).toHaveTextContent("below the minimum supported 2.0.0");
    // AP-NFR-003: the refusal has a surface of its own, so it is not demoted to
    // a toast that disappears on its own.
    expect(addToast).not.toHaveBeenCalled();
  });

  it("falls through to a toast when the refusal carries no launchFailure", () => {
    failLaunchesWith(apiErrorWith());
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(addToast).toHaveBeenCalledWith(REFUSAL_MESSAGE);
    expect(screen.queryByTestId("agent-launch-failure")).toBeNull();
  });

  it("falls through to a toast when the failure is not an ApiError", () => {
    failLaunchesWith(new Error("spawn ENOENT"));
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(addToast).toHaveBeenCalledWith("spawn ENOENT");
    expect(screen.queryByTestId("agent-launch-failure")).toBeNull();
  });

  // The panel renders `failure.message` as its headline, so a details payload
  // that only looks structured must not reach it: an empty panel would be the
  // silent dead terminal all over again.
  it("falls through to a toast when the launchFailure carries no message", () => {
    failLaunchesWith(apiErrorWith({ class: "missing-binary", actions: ["retry"] }));
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });

    expect(addToast).toHaveBeenCalledWith(REFUSAL_MESSAGE);
    expect(screen.queryByTestId("agent-launch-failure")).toBeNull();
  });

  it("replays the recorded agent launch when Retry is pressed (AP-TC-075)", () => {
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });
    expect(mockCreateMutate).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByTestId("agent-launch-failure-retry"));
    });

    expect(mockCreateMutate).toHaveBeenCalledTimes(2);
    expect(mockCreateMutate.mock.calls[1][0]).toMatchObject({
      agentPluginId: "claude-code",
      jigId: "feature-dev",
    });
    // Retry re-runs the same launch, not a generic one.
    expect(mockCreateMutate.mock.calls[1][0]).toEqual(mockCreateMutate.mock.calls[0][0]);
  });

  // The bare-command path has its own `onError` branch and its own entry in the
  // recorded-launch ref, so Retry has to stay on that path rather than falling
  // into the agent pipeline.
  it("raises the panel from the bare-command path and replays that command on Retry", () => {
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "New Terminal" }));
    });

    expect(screen.getByTestId("agent-launch-failure")).toBeTruthy();
    expect(mockCreateMutate.mock.calls[0][0]).not.toHaveProperty("agentPluginId");

    act(() => {
      fireEvent.click(screen.getByTestId("agent-launch-failure-retry"));
    });

    expect(mockCreateMutate).toHaveBeenCalledTimes(2);
    expect(mockCreateMutate.mock.calls[1][0]).toEqual(mockCreateMutate.mock.calls[0][0]);
    expect(mockCreateMutate.mock.calls[1][0]).not.toHaveProperty("agentPluginId");
  });

  it("clears the panel once a launch succeeds", () => {
    renderTabs();

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    });
    expect(screen.getByTestId("agent-launch-failure")).toBeTruthy();

    succeedLaunches();
    act(() => {
      fireEvent.click(screen.getByTestId("agent-launch-failure-retry"));
    });

    expect(screen.queryByTestId("agent-launch-failure")).toBeNull();
  });
});
