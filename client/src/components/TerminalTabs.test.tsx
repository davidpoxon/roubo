// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import TerminalTabs from "./TerminalTabs";

vi.mock("../hooks/useTerminal");
vi.mock("../hooks/useJigs");
vi.mock("../hooks/useSettings");
vi.mock("../hooks/useBenches");
vi.mock("../hooks/useToast");
vi.mock("../hooks/useAgentTools");
vi.mock("../hooks/useProjectAgents");
vi.mock("./Terminal", () => ({ default: () => null }));

import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { useTerminalSessions, useCreateTerminal, useDestroyTerminal } from "../hooks/useTerminal";
import { useJigs, useInjectJig } from "../hooks/useJigs";
import { useSettings } from "../hooks/useSettings";
import { useDismissNotification } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";
import { useAgentPresets } from "../hooks/useAgentTools";
import { useProjectAgents } from "../hooks/useProjectAgents";

const mockInjectMutate = vi.fn();
const mockCreateMutate = vi.fn();

const JIGS = [
  {
    id: "feature-dev",
    name: "Feature Dev",
    description: "",
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

function setupAgentMocks(
  presets: ResolvedAgentPreset[] = [DEFAULT_PRESET, PLAN_PRESET],
  agents: ProjectAgentState[] = [CLAUDE_AGENT],
) {
  vi.mocked(useAgentPresets).mockReturnValue({ data: { presets } } as unknown as ReturnType<
    typeof useAgentPresets
  >);
  vi.mocked(useProjectAgents).mockReturnValue({
    data: { agents, orphanedOverrides: [] },
  } as unknown as ReturnType<typeof useProjectAgents>);
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
        type: "claude-waiting" as const,
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
        type: "claude-waiting" as const,
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
        type: "claude-waiting" as const,
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
        type: "claude-waiting" as const,
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

describe("TerminalTabs: mode badge", () => {
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

  it('shows "auto" badge when session has claudeCodeMode "auto"', () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
          claudeCodeMode: "auto" as const,
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    expect(screen.getByText("auto")).toBeInTheDocument();
  });

  it('shows "plan → auto" badge when session has claudeCodeMode "plan-auto"', () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
          claudeCodeMode: "plan-auto" as const,
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    expect(screen.getByText("plan \u2192 auto")).toBeInTheDocument();
  });

  it('shows "plan" badge when session has claudeCodeMode "plan"', () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
          claudeCodeMode: "plan" as const,
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    expect(screen.getByText("plan")).toBeInTheDocument();
  });

  it("shows no badge when session has no claudeCodeMode", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    expect(screen.queryByText("auto")).toBeNull();
    expect(screen.queryByText("plan")).toBeNull();
    expect(screen.queryByText("plan \u2192 auto")).toBeNull();
  });

  it("shows no badge for a plain terminal session", () => {
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "session-1",
          benchKey: "p:1",
          label: "Terminal 1",
          createdAt: "2024-01-01",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs projectId="proj" benchId={1} projectName="Project" hasAssignedIssue={false} />,
    );

    expect(screen.queryByText("auto")).toBeNull();
    expect(screen.queryByText("plan")).toBeNull();
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

  it("keeps the identity glyph on a legacy built-in Claude session (#521 owns its removal)", () => {
    setup([
      {
        id: "claude-session",
        benchKey: "p:1",
        label: "Claude 1",
        createdAt: "2024-01-01",
        command: "claude",
        status: "live",
      },
    ]);

    expect(screen.getByTestId("session-agent-icon").getAttribute("class")).toContain(
      "text-violet-400",
    );
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
        type: "claude-waiting" as const,
        priority: "action-needed" as const,
        sourceSessionId: "session-a",
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "n-b",
        type: "claude-waiting" as const,
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
        type: "claude-waiting" as const,
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
        type: "claude-waiting" as const,
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
        type: "claude-waiting" as const,
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
      type: "claude-waiting" as const,
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
