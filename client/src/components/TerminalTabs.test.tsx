// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, act, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "../test/renderWithProviders";
import TerminalTabs from "./TerminalTabs";

vi.mock("../hooks/useTerminal");
vi.mock("../hooks/useBlueprints");
vi.mock("../hooks/useSettings");
vi.mock("../hooks/useBenches");
vi.mock("../hooks/useToast");
vi.mock("./Terminal", () => ({ default: () => null }));

import { useTerminalSessions, useCreateTerminal, useDestroyTerminal } from "../hooks/useTerminal";
import { useBlueprints, useInjectBlueprint } from "../hooks/useBlueprints";
import { useSettings } from "../hooks/useSettings";
import { useDismissNotification } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";

const mockInjectMutate = vi.fn();
const mockCreateMutate = vi.fn();

const BLUEPRINTS = [
  {
    id: "feature-dev",
    name: "Feature Dev",
    description: "",
    source: "app" as const,
  },
];

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
  vi.mocked(useBlueprints).mockReturnValue({
    data: BLUEPRINTS,
  } as unknown as ReturnType<typeof useBlueprints>);
  vi.mocked(useInjectBlueprint).mockReturnValue({
    mutate: mockInjectMutate,
  } as unknown as ReturnType<typeof useInjectBlueprint>);
  vi.mocked(useSettings).mockReturnValue({
    settings: isLoading
      ? undefined
      : {
          theme: "dark",
          blueprints: {
            autoInject,
            autoExecute: false,
            defaultBlueprintId: "feature-dev",
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

describe("TerminalTabs — autoInject behaviour", () => {
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

  it("does not pass blueprintId when autoInject is false and no explicit blueprintId", () => {
    setupMocks({ autoInject: false });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    // Empty-state "Claude Code" button calls handleCreate('claude') with no blueprintId
    const claudeButton = screen.getByRole("button", { name: "Claude Code" });
    act(() => {
      fireEvent.click(claudeButton);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintId: undefined }),
      expect.anything(),
    );
    expect(mockInjectMutate).not.toHaveBeenCalled();
  });

  it("passes blueprintId to createTerminal when autoInject is true and bench has an assigned issue", () => {
    setupMocks({ autoInject: true });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    const claudeButton = screen.getByRole("button", { name: "Claude Code" });
    act(() => {
      fireEvent.click(claudeButton);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        blueprintId: "feature-dev",
      }),
      expect.anything(),
    );
    expect(mockInjectMutate).not.toHaveBeenCalled();
  });

  it("passes GLOBAL_DEFAULT_BLUEPRINT_ID sentinel when autoInject is true but no defaultBlueprintId is configured", () => {
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        blueprints: { autoInject: true, autoExecute: false },
      },
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

    const claudeButton = screen.getByRole("button", { name: "Claude Code" });
    act(() => {
      fireEvent.click(claudeButton);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        blueprintId: "__global_default__",
      }),
      expect.anything(),
    );
  });

  it("does not pass blueprintId when autoInject is true but bench has no assigned issue", () => {
    setupMocks({ autoInject: true });
    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={false}
      />,
    );

    const claudeButton = screen.getByRole("button", { name: "Claude Code" });
    act(() => {
      fireEvent.click(claudeButton);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintId: undefined }),
      expect.anything(),
    );
    expect(mockInjectMutate).not.toHaveBeenCalled();
  });

  it("passes explicit blueprintId to createTerminal when autoInject is false", () => {
    setupMocks({ autoInject: false });
    // Override sessions so the tab bar renders (and with it the split-button dropdown)
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
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
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    // Select the "Feature Dev" menu item — calls handleCreate('claude', 'feature-dev')
    const menuItem = screen.getByRole("menuitem", { name: "Feature Dev" });
    act(() => {
      fireEvent.click(menuItem);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        blueprintId: "feature-dev",
      }),
      expect.anything(),
    );
    expect(mockInjectMutate).not.toHaveBeenCalled();
  });

  it('passes blueprintId: undefined when "Launch without blueprint" is selected with autoInject on and assigned issue', () => {
    setupMocks({ autoInject: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    // Open the chevron dropdown via its accessible label
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    const freshItem = screen.getByRole("menuitem", {
      name: /Launch without blueprint/,
    });
    act(() => {
      fireEvent.click(freshItem);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude", blueprintId: undefined }),
      expect.anything(),
    );
    expect(mockInjectMutate).not.toHaveBeenCalled();
  });

  it("shows the fresh-launch option in dropdown even when no blueprints are configured if autoInject would fire", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useBlueprints).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useBlueprints>);
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
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
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    const freshItem = screen.getByRole("menuitem", {
      name: /Launch without blueprint/,
    });
    act(() => {
      fireEvent.click(freshItem);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ command: "claude", blueprintId: undefined }),
      expect.anything(),
    );
  });

  it('does not show "Launch without blueprint" in dropdown when autoInject is false', () => {
    setupMocks({ autoInject: false });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
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
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    expect(screen.queryByRole("menuitem", { name: /Launch without blueprint/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Feature Dev" })).toBeInTheDocument();
  });

  it('does not show "Launch without blueprint" in dropdown when bench has no assigned issue', () => {
    setupMocks({ autoInject: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
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
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    expect(screen.queryByRole("menuitem", { name: /Launch without blueprint/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Feature Dev" })).toBeInTheDocument();
  });

  it('does not show "Launch without blueprint" while settings are loading', () => {
    setupMocks({ autoInject: true, isLoading: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    // When blueprints are available the dropdown still shows, but fresh item should be absent
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    expect(screen.queryByRole("menuitem", { name: /Launch without blueprint/ })).toBeNull();
  });

  it('shows both "Launch without blueprint" and blueprint items when autoInject is true and blueprints are available', () => {
    setupMocks({ autoInject: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
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
      fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
    });

    expect(screen.getByRole("menuitem", { name: /Launch without blueprint/ })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Feature Dev" })).toBeInTheDocument();
  });

  it("calls addToast with the error message when terminal creation fails", () => {
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

    const claudeButton = screen.getByRole("button", { name: "Claude Code" });
    act(() => {
      fireEvent.click(claudeButton);
    });

    expect(mockAddToast).toHaveBeenCalledWith("spawn failed: claude not found");
  });

  it("main split-button click still applies auto-inject (regression guard)", () => {
    setupMocks({ autoInject: true });
    vi.mocked(useTerminalSessions).mockReturnValue({
      data: [
        {
          id: "existing-session",
          benchKey: "project1:1",
          label: "Claude 1",
          createdAt: "2024-01-01",
          command: "claude",
          status: "live",
        },
      ],
    } as unknown as ReturnType<typeof useTerminalSessions>);

    renderWithProviders(
      <TerminalTabs
        projectId="project1"
        benchId={1}
        projectName="Project"
        hasAssignedIssue={true}
      />,
    );

    // Find the left-half Claude button (has Bot icon, no ChevronDown sibling inside)
    const claudeMainButton = screen
      .getAllByRole("button")
      .find(
        (b) =>
          b.querySelector("svg.lucide-bot") !== null &&
          b.querySelector("svg.lucide-chevron-down") === null,
      );
    if (!claudeMainButton) throw new Error("Claude main button not found");
    act(() => {
      fireEvent.click(claudeMainButton);
    });

    expect(mockCreateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "claude",
        blueprintId: "feature-dev",
      }),
      expect.anything(),
    );
  });
});

describe("TerminalTabs — notification indicators", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useBlueprints).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useBlueprints>);
    vi.mocked(useInjectBlueprint).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectBlueprint>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        blueprints: {
          autoInject: false,
          autoExecute: false,
          defaultBlueprintId: "feature-dev",
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

    // session-1 is the only/active tab — indicator should be suppressed
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

describe("TerminalTabs — mode badge", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useBlueprints).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useBlueprints>);
    vi.mocked(useInjectBlueprint).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectBlueprint>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        blueprints: {
          autoInject: false,
          autoExecute: false,
          defaultBlueprintId: "feature-dev",
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

describe("TerminalTabs — tab-switch dismiss behaviour", () => {
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
    vi.mocked(useBlueprints).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useBlueprints>);
    vi.mocked(useInjectBlueprint).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectBlueprint>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        blueprints: {
          autoInject: false,
          autoExecute: false,
          defaultBlueprintId: "feature-dev",
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

    // session-a is the active tab on mount — its notification should be dismissed immediately
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

describe("TerminalTabs — terminal session persistence", () => {
  function setupSessionMocks(sessions: { id: string; label: string }[]) {
    vi.mocked(useDestroyTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useDestroyTerminal>);
    vi.mocked(useCreateTerminal).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useCreateTerminal>);
    vi.mocked(useBlueprints).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useBlueprints>);
    vi.mocked(useInjectBlueprint).mockReturnValue({
      mutate: vi.fn(),
    } as unknown as ReturnType<typeof useInjectBlueprint>);
    vi.mocked(useSettings).mockReturnValue({
      settings: {
        theme: "dark",
        blueprints: {
          autoInject: false,
          autoExecute: false,
          defaultBlueprintId: "feature-dev",
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

    // Terminal 2 (session-b) should be the active tab — its container is visually distinct
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
