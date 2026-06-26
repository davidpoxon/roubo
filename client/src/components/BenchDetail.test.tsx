// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DirtyReason } from "@roubo/shared";
import BenchDetail from "./BenchDetail";
import { ApiError } from "../lib/api";

vi.mock("../hooks/useBenches");
vi.mock("../hooks/useProjects");
vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(() => ({ data: undefined })),
}));
vi.mock("../hooks/useClearingTracker");
vi.mock("../hooks/useContainers");
vi.mock("../hooks/useToast");
vi.mock("../hooks/useElapsed", () => ({ useElapsed: () => null }));
vi.mock("./ComponentStatusDot", () => ({ default: () => <span data-testid="status-dot" /> }));
vi.mock("./ToolButtons", () => ({ default: () => <span data-testid="tool-buttons" /> }));
vi.mock("./LogStream", () => ({ default: () => <div data-testid="log-stream" /> }));
vi.mock("./TerminalTabs", () => ({ default: () => <div data-testid="terminal-tabs" /> }));
vi.mock("./InspectionRunner", () => ({ default: () => <div data-testid="inspection-runner" /> }));
vi.mock("./AssignContainerModal", () => ({ default: () => null }));
vi.mock("./IssueTransitionDropdown", () => ({
  default: () => <span data-testid="issue-transition-dropdown" />,
}));
const issueAssignControlMock = vi.fn();
vi.mock("./IssueAssignControl", () => ({
  default: (props: Record<string, unknown>) => {
    issueAssignControlMock(props);
    return <span data-testid="issue-assign-control" />;
  },
}));
vi.mock("../hooks/useBenchIssue", () => ({
  useBenchIssue: vi.fn(() => ({ data: undefined })),
}));
vi.mock("./testbench/TestBenchPanel", () => ({
  default: () => <div data-testid="testbench-panel" />,
}));
import { useBenchIssue } from "../hooks/useBenchIssue";
const mockUseBenchIssue = vi.mocked(useBenchIssue);

import {
  useBenchDetail,
  useStartBench,
  useStopBench,
  useTeardownBench,
  useCleanupAndRetryBench,
  useStartComponent,
  useStopComponent,
  useDismissBenchNotifications,
} from "../hooks/useBenches";
import { useProjects } from "../hooks/useProjects";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useTeardownTracker } from "../hooks/useClearingTracker";
import { useUnassignContainer } from "../hooks/useContainers";
import { useToast } from "../hooks/useToast";

const mockUseBenchDetail = vi.mocked(useBenchDetail);
const mockUseProjects = vi.mocked(useProjects);
const mockUseTeardownTracker = vi.mocked(useTeardownTracker);
const mockUseUnassignContainer = vi.mocked(useUnassignContainer);

function makeMutation() {
  return { mutate: vi.fn(), isPending: false } as never;
}

const baseBench = {
  id: 1,
  projectId: "proj-1",
  branch: "feature/my-branch",
  status: "active",
  provisioningSteps: [],
  teardownSteps: [],
  notifications: [],
  components: {
    server: {
      status: "running",
      startedAt: "2024-01-01T00:00:00Z",
      phases: [],
      setupComplete: true,
    },
  },
  ports: { frontend: 3000 },
  workspacePath: "/workspace/bench-1",
  createdAt: "2024-01-01T00:00:00Z",
  assignedContainers: {},
  assignedIssue: null,
};

const baseProject = {
  id: "proj-1",
  repoPath: "/repo",
  configValid: true,
  config: {
    project: { name: "my-app", displayName: "My App" },
    components: { server: { type: "process", command: "npm start" } },
    inspection: { command: "npx playwright test", framework: "playwright", directory: "tests" },
  },
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(useStartBench).mockReturnValue(makeMutation());
  vi.mocked(useStopBench).mockReturnValue(makeMutation());
  vi.mocked(useTeardownBench).mockReturnValue(makeMutation());
  vi.mocked(useCleanupAndRetryBench).mockReturnValue(makeMutation());
  vi.mocked(useStartComponent).mockReturnValue(makeMutation());
  vi.mocked(useStopComponent).mockReturnValue(makeMutation());
  vi.mocked(useDismissBenchNotifications).mockReturnValue(makeMutation());
  mockUseUnassignContainer.mockReturnValue(makeMutation());
  mockUseTeardownTracker.mockReturnValue({ register: vi.fn(), teardowns: new Map() } as never);
  mockUseProjects.mockReturnValue({ data: [baseProject] } as never);
  vi.mocked(useToast).mockReturnValue({ addToast: vi.fn(), removeToast: vi.fn() });

  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    writable: true,
    configurable: true,
  });
});

function renderBench(bench = baseBench as never) {
  mockUseBenchDetail.mockReturnValue({ data: bench, isLoading: false, isError: false } as never);
  return render(
    <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
      <Routes>
        <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        <Route path="/projects/:projectId" element={<div>Project page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BenchDetail", () => {
  it("shows loading state while fetching", () => {
    mockUseBenchDetail.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as never);
    render(
      <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
        <Routes>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows not found state when bench missing", () => {
    mockUseBenchDetail.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as never);
    render(
      <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
        <Routes>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/bench not found/i)).toBeInTheDocument();
  });

  it("renders branch name", () => {
    renderBench();
    expect(screen.getByText("feature/my-branch")).toBeInTheDocument();
  });

  it('renders "Branched from" line when bench has baseBranch and baseCommit', () => {
    renderBench({ ...baseBench, baseBranch: "main", baseCommit: "abc1234" } as never);
    expect(screen.getByText(/branched from/i)).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });

  it('hides the "Branched from" line when base fields are absent', () => {
    renderBench();
    expect(screen.queryByText(/branched from/i)).not.toBeInTheDocument();
  });

  it("shows running status badge", () => {
    renderBench();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("shows Stop All button when bench is active", () => {
    renderBench();
    expect(screen.getByRole("button", { name: /stop all/i })).toBeInTheDocument();
  });

  it("shows Start All button when bench is inactive", () => {
    renderBench({ ...baseBench, status: "inactive" } as never);
    expect(screen.getByRole("button", { name: /start all/i })).toBeInTheDocument();
  });

  it("renders component entries", () => {
    renderBench();
    expect(screen.getByText("server")).toBeInTheDocument();
  });

  it("renders port information in Info tab", async () => {
    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: /info/i }));
    expect(screen.getByText("3000")).toBeInTheDocument();
  });

  it("renders workspace path in Info tab", async () => {
    renderBench();
    await userEvent.click(screen.getByRole("tab", { name: /info/i }));
    expect(screen.getByText("/workspace/bench-1")).toBeInTheDocument();
  });

  it("shows teardown dialog when Clear is clicked", async () => {
    renderBench();
    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(screen.getByText(/clear bench/i)).toBeInTheDocument();
  });

  it("calls teardown mutation and registerTeardown (via onSuccess) when confirmed in dialog", async () => {
    const registerTeardown = vi.fn();
    const teardownMutate = vi.fn((_vars: unknown, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });
    vi.mocked(useTeardownBench).mockReturnValue({
      mutate: teardownMutate,
      isPending: false,
    } as never);
    mockUseTeardownTracker.mockReturnValue({
      register: registerTeardown,
      teardowns: new Map(),
    } as never);
    renderBench();
    await userEvent.click(screen.getByRole("button", { name: /clear/i }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /^clear$/i }));
    expect(teardownMutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", benchId: 1 }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(registerTeardown).toHaveBeenCalledWith("proj-1", 1, "feature/my-branch");
  });

  it("shows a toast when cleanup and retry fails", async () => {
    const addToast = vi.fn();
    vi.mocked(useToast).mockReturnValue({ addToast, removeToast: vi.fn() });
    const cleanupMutate = vi.fn(
      (_vars: unknown, options?: { onError?: (err: unknown) => void }) => {
        options?.onError?.(new Error("git worktree remove --force /workspace/bench-1 failed"));
      },
    );
    vi.mocked(useCleanupAndRetryBench).mockReturnValue({
      mutate: cleanupMutate,
      isPending: false,
    } as never);
    renderBench({ ...baseBench, status: "error", error: "provisioning failed" } as never);
    await userEvent.click(screen.getByRole("button", { name: /cleanup & retry/i }));
    expect(addToast).toHaveBeenCalledWith(
      "git worktree remove --force /workspace/bench-1 failed",
      expect.objectContaining({ duration: 8000 }),
    );
  });

  it("collapses long errors with a Show more toggle by default", async () => {
    const longError = "x".repeat(500);
    renderBench({ ...baseBench, status: "error", error: longError } as never);
    const errorParagraph = screen.getByText(longError);
    expect(errorParagraph.className).toContain("line-clamp-3");
    expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show less/i })).not.toBeInTheDocument();
  });

  it("expands long errors when Show more is clicked", async () => {
    const longError = "x".repeat(500);
    renderBench({ ...baseBench, status: "error", error: longError } as never);
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    const errorParagraph = screen.getByText(longError);
    expect(errorParagraph.className).not.toContain("line-clamp-3");
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();
  });

  it("does not show a collapse toggle for short errors", () => {
    renderBench({ ...baseBench, status: "error", error: "provisioning failed" } as never);
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show less/i })).not.toBeInTheDocument();
  });

  it("keeps Cleanup & Retry visible when the error is collapsed and expanded", async () => {
    const longError = "x".repeat(500);
    renderBench({ ...baseBench, status: "error", error: longError } as never);
    expect(screen.getByRole("button", { name: /cleanup & retry/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getByRole("button", { name: /cleanup & retry/i })).toBeInTheDocument();
  });

  it("recollapses when the error string changes after being expanded", async () => {
    const firstError = "x".repeat(500);
    const secondError = "y".repeat(500);
    mockUseBenchDetail.mockReturnValue({
      data: { ...baseBench, status: "error", error: firstError } as never,
      isLoading: false,
      isError: false,
    } as never);
    const { rerender } = render(
      <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
        <Routes>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getByRole("button", { name: /show less/i })).toBeInTheDocument();

    mockUseBenchDetail.mockReturnValue({
      data: { ...baseBench, status: "error", error: secondError } as never,
      isLoading: false,
      isError: false,
    } as never);
    rerender(
      <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
        <Routes>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(secondError).className).toContain("line-clamp-3");
    expect(screen.getByRole("button", { name: /show more/i })).toBeInTheDocument();
  });

  it("sets aria-expanded on the disclosure button to reflect state", async () => {
    const longError = "x".repeat(500);
    renderBench({ ...baseBench, status: "error", error: longError } as never);
    const toggle = screen.getByRole("button", { name: /show more/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "bench-error-message");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: /show less/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows inspection tab when project has inspection config", () => {
    renderBench();
    expect(screen.getByRole("tab", { name: /inspection/i })).toBeInTheDocument();
  });

  it("renders tool buttons", () => {
    renderBench();
    expect(screen.getByTestId("tool-buttons")).toBeInTheDocument();
  });

  it("renders provisioning steps during preparation", () => {
    const preparingBench = {
      ...baseBench,
      status: "preparing",
      provisioningSteps: [{ id: "step-1", label: "Installing", status: "running" }],
    };
    renderBench(preparingBench as never);
    expect(screen.getByText("Installing")).toBeInTheDocument();
  });

  it("shows blocked badge and renders the blocker refs (string[]) when assigned issue has blockers", async () => {
    renderBench({
      ...baseBench,
      assignedIssue: {
        number: 42,
        title: "Fix the bug",
        // blockedBy is now a string[] of externalIds.
        blockedBy: ["owner/repo#10"],
      },
    } as never);
    const badge = screen.getByRole("button", { name: /blocked/i });
    expect(badge).toBeInTheDocument();

    // The tooltip renders each blocker via shortIssueRef (strips the owner/repo).
    await userEvent.hover(badge);
    expect(await screen.findByText("#10")).toBeInTheDocument();
  });

  it("does not show blocked badge when assigned issue has no blockers", () => {
    renderBench({
      ...baseBench,
      assignedIssue: { number: 42, title: "Fix the bug", blockedBy: [] },
    } as never);
    expect(screen.queryByRole("button", { name: /blocked/i })).not.toBeInTheDocument();
  });

  it("does not show blocked badge when assigned issue has no blockedBy field", () => {
    renderBench({
      ...baseBench,
      assignedIssue: { number: 42, title: "Fix the bug" },
    } as never);
    expect(screen.queryByRole("button", { name: /blocked/i })).not.toBeInTheDocument();
  });

  describe("WU-033: alert-backed bench (TC-095)", () => {
    function mockBenchIssue(issueType: string | null) {
      mockUseBenchIssue.mockReturnValue({
        data: {
          integrationId: "github-com",
          externalId: "org/repo#code-scanning-7",
          externalUrl: "https://github.com/org/repo/security/code-scanning/7",
          title: "SQL injection",
          body: null,
          currentState: "open",
          allowedTransitions: [],
          assignees: [],
          labels: [],
          issueType,
          blocks: [],
          blockedBy: [],
          updatedAt: "2026-05-24T00:00:00Z",
          raw: null,
        },
      } as never);
    }

    function renderAlertBench(bench: typeof baseBench) {
      mockUseBenchDetail.mockReturnValue({
        data: bench,
        isLoading: false,
        isError: false,
      } as never);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
            <Routes>
              <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
              <Route path="/projects/:projectId" element={<div>Project page</div>} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    const alertBench = {
      ...baseBench,
      assignedIssue: {
        number: 7,
        integrationId: "github-com",
        externalId: "org/repo#code-scanning-7",
        title: "SQL injection",
      },
    };

    it("hides the Transition dropdown and shows the muted Resolved-by-pushing-code line", () => {
      mockBenchIssue("security-code-scanning");
      renderAlertBench(alertBench as never);
      expect(screen.queryByTestId("issue-transition-dropdown")).not.toBeInTheDocument();
      expect(screen.getByTestId("alert-bench-transition-explanation")).toHaveTextContent(
        "Resolved by pushing code that fixes the underlying alert. GitHub auto-closes the alert.",
      );
    });

    it("passes isDisabled and the documented tooltip copy to IssueAssignControl (TC-095)", () => {
      mockBenchIssue("security-dependabot");
      renderAlertBench(alertBench as never);
      expect(screen.getByTestId("issue-assign-control")).toBeInTheDocument();
      const props = issueAssignControlMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(props.isDisabled).toBe(true);
      expect(props.disabledTooltip).toBe(
        "Security alerts cannot be assigned from Roubo. They are repo-level findings, not user-assigned work.",
      );
    });

    it("renders the Transition dropdown and a non-disabled Assign for non-security issueTypes", () => {
      mockBenchIssue("bug");
      renderAlertBench(alertBench as never);
      expect(screen.getByTestId("issue-transition-dropdown")).toBeInTheDocument();
      expect(screen.queryByTestId("alert-bench-transition-explanation")).not.toBeInTheDocument();
      const props = issueAssignControlMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(props.isDisabled).toBeFalsy();
      expect(props.disabledTooltip).toBeUndefined();
    });
  });

  describe("notification indicators", () => {
    it("calls dismissBenchNotifications on mount to clear bench-level notifications", () => {
      const dismissMutate = vi.fn();
      vi.mocked(useDismissBenchNotifications).mockReturnValue({
        mutate: dismissMutate,
        isPending: false,
      } as never);
      renderBench();
      expect(dismissMutate).toHaveBeenCalledWith({ projectId: "proj-1", benchId: 1 });
    });

    it("shows notification indicator on Terminal tab for session-scoped notifications", () => {
      renderBench({
        ...baseBench,
        notifications: [
          {
            id: "n1",
            type: "claude-waiting",
            priority: "action-needed",
            sourceSessionId: "term-1",
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
      } as never);
      const terminalTab = screen.getByRole("tab", { name: /terminal/i });
      expect(terminalTab.querySelector('[role="img"]')).not.toBeNull();
    });

    it("does not show notification indicator on Terminal tab for bench-level notifications", () => {
      renderBench({
        ...baseBench,
        notifications: [
          { id: "n1", type: "bench-ready", priority: "info", createdAt: "2024-01-01T00:00:00Z" },
        ],
      } as never);
      const terminalTab = screen.getByRole("tab", { name: /terminal/i });
      expect(terminalTab.querySelector('[role="img"]')).toBeNull();
    });

    it("does not show notification indicator on Terminal tab when bench has no notifications", () => {
      renderBench({ ...baseBench, notifications: [] } as never);
      const terminalTab = screen.getByRole("tab", { name: /terminal/i });
      expect(terminalTab.querySelector('[role="img"]')).toBeNull();
    });
  });

  describe("tab persistence", () => {
    it("restores the last-selected tab after unmount and remount", async () => {
      const { unmount } = renderBench();
      await userEvent.click(screen.getByRole("tab", { name: /info/i }));
      expect(screen.getByRole("tab", { name: /info/i })).toHaveAttribute("aria-selected", "true");

      unmount();
      renderBench();

      expect(screen.getByRole("tab", { name: /info/i })).toHaveAttribute("aria-selected", "true");
    });

    it("falls back to Components when the persisted tab is no longer available", async () => {
      // baseProject has inspection config, so Inspection tab is available
      const { unmount } = renderBench();
      await userEvent.click(screen.getByRole("tab", { name: /inspection/i }));
      expect(screen.getByRole("tab", { name: /inspection/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );

      unmount();

      // Re-render with a project config that has no inspection
      const projectWithoutInspection = {
        ...baseProject,
        config: { ...baseProject.config, inspection: undefined },
      };
      mockUseProjects.mockReturnValue({ data: [projectWithoutInspection] } as never);
      renderBench();

      // Inspection tab is gone; should fall back to Components
      expect(screen.queryByRole("tab", { name: /inspection/i })).not.toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /components/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("keeps separate tab state per bench when navigating without unmounting", async () => {
      // Harness: a nav button + the route, so BenchDetail stays mounted
      // across navigation (react-router v6 keeps the same element alive when
      // only params change: this is the real-world bug path).
      function Harness() {
        const navigate = useNavigate();
        return (
          <>
            <button onClick={() => navigate("/projects/proj-1/benches/2")}>go-bench-2</button>
            <Routes>
              <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
            </Routes>
          </>
        );
      }

      mockUseBenchDetail.mockImplementation(
        (_projectId, benchId) =>
          ({
            data: { ...baseBench, id: benchId as number },
            isLoading: false,
            isError: false,
          }) as never,
      );

      render(
        <MemoryRouter initialEntries={["/projects/proj-1/benches/1"]}>
          <Harness />
        </MemoryRouter>,
      );

      // Select Info tab on bench 1
      await userEvent.click(screen.getByRole("tab", { name: /info/i }));
      expect(screen.getByRole("tab", { name: /info/i })).toHaveAttribute("aria-selected", "true");

      // Navigate to bench 2 without unmounting BenchDetail
      await userEvent.click(screen.getByRole("button", { name: /go-bench-2/i }));

      // Bench 2 has no persisted tab: should default to Components, NOT Info
      expect(screen.getByRole("tab", { name: /components/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByRole("tab", { name: /info/i })).toHaveAttribute("aria-selected", "false");
    });
  });

  describe("TestBench variant tab (#418, #419)", () => {
    const testbenchBench = {
      ...baseBench,
      variant: "testbench",
      focusedSpecPath: ".specifications/demo/test-cases.json",
    };

    it("renders a TestBench first tab while keeping all existing tabs", () => {
      renderBench(testbenchBench as never);
      const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
      // TestBench is first, and the existing tabs remain.
      expect(tabs[0]).toMatch(/testbench/i);
      expect(screen.getByRole("tab", { name: /components/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /terminal/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /inspection/i })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /info/i })).toBeInTheDocument();
    });

    it("selects the TestBench tab by default and shows its panel", () => {
      renderBench(testbenchBench as never);
      expect(screen.getByRole("tab", { name: /testbench/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByTestId("testbench-panel")).toBeInTheDocument();
    });

    it("does not render the TestBench tab for a non-testbench bench", () => {
      renderBench();
      expect(screen.queryByRole("tab", { name: /testbench/i })).not.toBeInTheDocument();
    });

    it("opens on the TestBench tab when it is the persisted active tab (#418)", () => {
      localStorage.setItem(
        "roubo-bench-view-state",
        JSON.stringify({ "proj-1:1": { activeTab: "testbench" } }),
      );
      renderBench(testbenchBench as never);
      expect(screen.getByRole("tab", { name: /testbench/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByTestId("testbench-panel")).toBeInTheDocument();
    });

    it("ignores a persisted testbench tab for a non-testbench bench (#418)", () => {
      localStorage.setItem(
        "roubo-bench-view-state",
        JSON.stringify({ "proj-1:1": { activeTab: "testbench" } }),
      );
      renderBench();
      expect(screen.getByRole("tab", { name: /components/i })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  describe("dirty-bench confirmation", () => {
    const dirtyReasons: DirtyReason[] = [
      { kind: "dirty-worktree", location: "workspace", detail: "3 modified" },
      { kind: "stash", location: "vendor/ui", detail: "2 stashes" },
    ];

    it("opens dirty-bench dialog when teardown returns 409 bench-dirty", async () => {
      const registerTeardown = vi.fn();
      const teardownMutate = vi.fn(
        (_vars: unknown, options?: { onError?: (err: unknown) => void }) => {
          options?.onError?.(new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }));
        },
      );
      vi.mocked(useTeardownBench).mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as never);
      mockUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
        teardowns: new Map(),
      } as never);

      renderBench();
      await userEvent.click(screen.getByRole("button", { name: /clear/i }));
      const firstDialog = screen.getByRole("dialog");
      await userEvent.click(within(firstDialog).getByRole("button", { name: /^clear$/i }));

      expect(
        screen.getByRole("dialog", { name: /uncommitted work detected/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("3 modified")).toBeInTheDocument();
      expect(screen.getByText("2 stashes")).toBeInTheDocument();
      expect(registerTeardown).not.toHaveBeenCalled();
    });

    it("retries with force=true and calls registerTeardown when dirty dialog is confirmed", async () => {
      const registerTeardown = vi.fn();
      let callCount = 0;
      const teardownMutate = vi.fn(
        (
          _vars: unknown,
          options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
        ) => {
          callCount++;
          if (callCount === 1) {
            options?.onError?.(
              new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }),
            );
          } else {
            options?.onSuccess?.();
          }
        },
      );
      vi.mocked(useTeardownBench).mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as never);
      mockUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
        teardowns: new Map(),
      } as never);

      renderBench();
      await userEvent.click(screen.getByRole("button", { name: /clear/i }));
      const firstDialog = screen.getByRole("dialog");
      await userEvent.click(within(firstDialog).getByRole("button", { name: /^clear$/i }));
      // Dirty dialog is open: confirm it
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));

      expect(teardownMutate).toHaveBeenCalledTimes(2);
      expect(teardownMutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: "proj-1", benchId: 1, force: true }),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      expect(registerTeardown).toHaveBeenCalledTimes(1);
      expect(registerTeardown).toHaveBeenCalledWith("proj-1", 1, "feature/my-branch");
    });

    it("closes dirty dialog without retrying when Cancel is pressed", async () => {
      const registerTeardown = vi.fn();
      const teardownMutate = vi.fn(
        (_vars: unknown, options?: { onError?: (err: unknown) => void }) => {
          options?.onError?.(new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }));
        },
      );
      vi.mocked(useTeardownBench).mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as never);
      mockUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
        teardowns: new Map(),
      } as never);

      renderBench();
      await userEvent.click(screen.getByRole("button", { name: /clear/i }));
      const firstDialog = screen.getByRole("dialog");
      await userEvent.click(within(firstDialog).getByRole("button", { name: /^clear$/i }));
      // Dirty dialog opens: cancel it
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(
        screen.queryByRole("dialog", { name: /uncommitted work detected/i }),
      ).not.toBeInTheDocument();
      expect(teardownMutate).toHaveBeenCalledTimes(1);
      expect(registerTeardown).not.toHaveBeenCalled();
    });

    it("does not show dirty dialog for removeWorkspace=false teardown", async () => {
      // With removeWorkspace=false the server never runs the dirty check, so the
      // client should simply succeed without any dirty dialog appearing.
      const teardownMutate = vi.fn((_vars: unknown, options?: { onSuccess?: () => void }) => {
        options?.onSuccess?.();
      });
      vi.mocked(useTeardownBench).mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as never);

      renderBench();
      await userEvent.click(screen.getByRole("button", { name: /clear/i }));
      // Uncheck "Remove git worktree" checkbox
      const checkbox = screen.getByRole("checkbox", { name: /remove git worktree/i });
      await userEvent.click(checkbox);
      const firstDialog = screen.getByRole("dialog");
      await userEvent.click(within(firstDialog).getByRole("button", { name: /^clear$/i }));

      expect(
        screen.queryByRole("dialog", { name: /uncommitted work detected/i }),
      ).not.toBeInTheDocument();
      expect(teardownMutate).toHaveBeenCalledWith(
        expect.objectContaining({ removeWorkspace: false }),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });

    it("clears stale forceError when a retry hits a fresh bench-dirty 409", async () => {
      const registerTeardown = vi.fn();
      let callCount = 0;
      const teardownMutate = vi.fn(
        (
          _vars: unknown,
          options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
        ) => {
          callCount++;
          if (callCount === 1) {
            options?.onError?.(
              new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }),
            );
          } else if (callCount === 2) {
            options?.onError?.(new ApiError("Server error", 500));
          } else {
            options?.onError?.(
              new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }),
            );
          }
        },
      );
      vi.mocked(useTeardownBench).mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as never);
      mockUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
        teardowns: new Map(),
      } as never);

      renderBench();
      await userEvent.click(screen.getByRole("button", { name: /clear/i }));
      const firstDialog = screen.getByRole("dialog");
      await userEvent.click(within(firstDialog).getByRole("button", { name: /^clear$/i }));
      // First force attempt → 500
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));
      expect(screen.getByText("Clear failed. Please try again.")).toBeInTheDocument();
      // Second force attempt → fresh dirty 409: stale error must disappear
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));
      expect(screen.queryByText("Clear failed. Please try again.")).not.toBeInTheDocument();
      expect(
        screen.getByRole("dialog", { name: /uncommitted work detected/i }),
      ).toBeInTheDocument();
      expect(registerTeardown).not.toHaveBeenCalled();
    });

    it("keeps dirty dialog open and shows error when force teardown fails with non-dirty error", async () => {
      const registerTeardown = vi.fn();
      let callCount = 0;
      const teardownMutate = vi.fn(
        (
          _vars: unknown,
          options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
        ) => {
          callCount++;
          if (callCount === 1) {
            options?.onError?.(
              new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }),
            );
          } else {
            options?.onError?.(new ApiError("Internal server error", 500));
          }
        },
      );
      vi.mocked(useTeardownBench).mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as never);
      mockUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
        teardowns: new Map(),
      } as never);

      renderBench();
      await userEvent.click(screen.getByRole("button", { name: /clear/i }));
      const firstDialog = screen.getByRole("dialog");
      await userEvent.click(within(firstDialog).getByRole("button", { name: /^clear$/i }));
      // Dirty dialog is open: confirm it
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));

      // Dialog must stay open and show an error: bench stays intact
      expect(
        screen.getByRole("dialog", { name: /uncommitted work detected/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("Clear failed. Please try again.")).toBeInTheDocument();
      expect(registerTeardown).not.toHaveBeenCalled();
    });
  });

  describe("previous integration handling", () => {
    const benchWithIssue = {
      ...baseBench,
      assignedIssue: {
        number: 7,
        integrationId: "github-com",
        externalId: "7",
        title: "Old issue",
      },
    };

    it("renders the badge when integration mismatch", async () => {
      vi.mocked(useProjectIntegration).mockReturnValue({
        data: {
          effective: { plugin: "jira-self-hosted" },
          committed: null,
          override: { plugin: "jira-self-hosted" },
          plugin: {
            id: "jira-self-hosted",
            installed: true,
            status: "enabled",
            manifest: { name: "Jira" },
          },
          captionKey: "override-only",
        },
      } as never);

      renderBench(benchWithIssue as never);

      expect(screen.getByTestId("previous-integration-badge")).toBeInTheDocument();
    });

    it("does not render the badge when integrations match", async () => {
      vi.mocked(useProjectIntegration).mockReturnValue({
        data: {
          effective: { plugin: "github-com" },
          committed: { plugin: "github-com" },
          override: null,
          plugin: {
            id: "github-com",
            installed: true,
            status: "enabled",
            manifest: { name: "GitHub.com" },
          },
          captionKey: "yaml-only",
        },
      } as never);

      renderBench(benchWithIssue as never);

      expect(screen.queryByTestId("previous-integration-badge")).not.toBeInTheDocument();
    });
  });

  describe("header collapse (#805)", () => {
    const benchWithMeta = {
      ...baseBench,
      baseBranch: "main",
      baseCommit: "abc1234",
    };

    it("collapses the header, hiding metadata and tabs while keeping the title row and actions", async () => {
      renderBench(benchWithMeta as never);
      // Expanded by default: metadata + tabs visible.
      expect(screen.getByText("feature/my-branch")).toBeInTheDocument();
      expect(screen.getByText(/branched from/i)).toBeInTheDocument();
      expect(screen.getByText("My App")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /components/i })).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /collapse bench header/i }));

      // Title row + actions remain; metadata + tabs are gone.
      expect(screen.getByText("Bench 1")).toBeInTheDocument();
      expect(screen.getByText("active")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /stop all/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
      expect(screen.queryByText("feature/my-branch")).not.toBeInTheDocument();
      expect(screen.queryByText(/branched from/i)).not.toBeInTheDocument();
      expect(screen.queryByText("My App")).not.toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /components/i })).not.toBeInTheDocument();
    });

    it("hides the error banner when collapsed", async () => {
      renderBench({ ...benchWithMeta, status: "error", error: "provisioning failed" } as never);
      expect(screen.getByText("provisioning failed")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /collapse bench header/i }));
      expect(screen.queryByText("provisioning failed")).not.toBeInTheDocument();
    });

    it("keeps the terminal mounted (not torn down) when collapsed (#805)", async () => {
      renderBench(benchWithMeta as never);
      // The Terminal panel uses shouldForceMount, so it is mounted while expanded.
      expect(screen.getByTestId("terminal-tabs")).toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /collapse bench header/i }));

      // Collapsing hides the tab row from the accessibility tree but must NOT unmount
      // the Tabs: the live terminal session has to survive a collapse/expand cycle.
      expect(screen.queryByRole("tab", { name: /components/i })).not.toBeInTheDocument();
      expect(screen.getByTestId("terminal-tabs")).toBeInTheDocument();
    });

    it("expands again, restoring metadata and tabs", async () => {
      renderBench(benchWithMeta as never);
      await userEvent.click(screen.getByRole("button", { name: /collapse bench header/i }));
      expect(screen.queryByRole("tab", { name: /components/i })).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: /expand bench header/i }));
      expect(screen.getByText("feature/my-branch")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /components/i })).toBeInTheDocument();
    });

    it("reflects collapsed state via aria-expanded", async () => {
      renderBench(benchWithMeta as never);
      const toggle = screen.getByRole("button", { name: /collapse bench header/i });
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      await userEvent.click(toggle);
      expect(screen.getByRole("button", { name: /expand bench header/i })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("persists the collapsed state across unmount and remount", async () => {
      const { unmount } = renderBench(benchWithMeta as never);
      await userEvent.click(screen.getByRole("button", { name: /collapse bench header/i }));
      expect(screen.queryByRole("tab", { name: /components/i })).not.toBeInTheDocument();

      unmount();
      renderBench(benchWithMeta as never);

      // Still collapsed: the toggle offers to expand and tabs stay hidden.
      expect(screen.getByRole("button", { name: /expand bench header/i })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: /components/i })).not.toBeInTheDocument();
    });

    it("keeps header collapse independent per bench", async () => {
      localStorage.setItem(
        "roubo-bench-view-state",
        JSON.stringify({ "proj-1:1": { headerCollapsed: true } }),
      );
      // Bench 1 persisted collapsed.
      const { unmount } = renderBench(benchWithMeta as never);
      expect(screen.getByRole("button", { name: /expand bench header/i })).toBeInTheDocument();
      unmount();

      // Bench 2 (no persisted entry) renders expanded.
      mockUseBenchDetail.mockReturnValue({
        data: { ...benchWithMeta, id: 2 },
        isLoading: false,
        isError: false,
      } as never);
      render(
        <MemoryRouter initialEntries={["/projects/proj-1/benches/2"]}>
          <Routes>
            <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByRole("button", { name: /collapse bench header/i })).toBeInTheDocument();
    });
  });
});
