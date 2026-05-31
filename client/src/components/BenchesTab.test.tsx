// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet } from "react-router-dom";
import type { Bench, RouboConfig } from "@roubo/shared";
import type { ProjectOutletContext } from "./BenchDashboard";
import { createEmptyFilters } from "../lib/cut-list-filters";
import { createEmptyGrouping } from "../lib/cut-list-groups";

vi.mock("./BenchCard", () => ({
  default: ({ bench }: { bench: Bench }) => <div data-testid="bench-card">{bench.id}</div>,
}));
vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(() => ({ data: undefined })),
}));
vi.mock("../hooks/useGlobalCap", () => ({
  useGlobalCap: vi.fn(),
}));
vi.mock("./EmptyBenchCard", () => ({
  default: ({
    position,
    onCreateBlank,
    onPickIssue,
  }: {
    position: number;
    onCreateBlank: () => void;
    onPickIssue: (p: number) => void;
  }) => (
    <div data-testid="empty-bench-card">
      {position}
      <button data-testid={`pick-issue-${position}`} onClick={() => onPickIssue(position)}>
        Pick
      </button>
      <button data-testid={`create-blank-${position}`} onClick={onCreateBlank}>
        Create
      </button>
    </div>
  ),
}));
vi.mock("./PendingBenchCard", () => ({
  default: ({ position }: { position: number }) => (
    <div data-testid="pending-bench-card">{position}</div>
  ),
}));
vi.mock("./IssueQueuePanel", () => ({
  default: ({ onCollapse }: { onCollapse?: () => void }) => (
    <div data-testid="issue-queue-panel">
      {onCollapse && (
        <button data-testid="collapse-queue" onClick={onCollapse}>
          Collapse
        </button>
      )}
    </div>
  ),
}));

import BenchesTab from "./BenchesTab";
import { useGlobalCap } from "../hooks/useGlobalCap";
import type { GlobalCapState } from "../hooks/useGlobalCap";

const mockUseGlobalCap = vi.mocked(useGlobalCap);

const UNCAPPED: GlobalCapState = {
  current: 0,
  max: null,
  isCapped: false,
  isAtCap: false,
  isOverCap: false,
};

beforeEach(() => {
  mockUseGlobalCap.mockReturnValue(UNCAPPED);
});

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-1",
    branch: "feat/test",
    workspacePath: "/ws/1",
    status: "idle",
    ports: {},
    components: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    ...overrides,
  };
}

function makeConfig(): RouboConfig {
  return {
    project: { name: "proj-1", displayName: "Project 1", type: "web" },
    layout: { type: "single-repo" },
    components: {},
    ports: {},
    benches: { max: 3 },
  } as RouboConfig;
}

function renderTab(ctx: ProjectOutletContext) {
  function Layout() {
    return <Outlet context={ctx} />;
  }
  render(
    <MemoryRouter initialEntries={["/projects/proj-1"]}>
      <Routes>
        <Route path="/projects/:projectId" element={<Layout />}>
          <Route index element={<BenchesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function makeContext(overrides: Partial<ProjectOutletContext> = {}): ProjectOutletContext {
  return {
    benchPositions: null,
    pendingAssignments: new Map(),
    isLoading: false,
    openCreateBench: vi.fn(),
    pickIssueForBench: vi.fn(),
    hasGitHub: false,
    benches: [],
    projectConfig: makeConfig(),
    pendingIssueExternalIds: new Set(),
    initialFilters: createEmptyFilters(),
    onFiltersChange: vi.fn(),
    initialGrouping: createEmptyGrouping(),
    onGroupingChange: vi.fn(),
    issueQueueCollapsed: false,
    onToggleIssueQueue: vi.fn(),
    projectId: "proj-1",
    ...overrides,
  };
}

describe("BenchesTab", () => {
  it("shows loading indicator while loading", () => {
    renderTab(makeContext({ isLoading: true }));
    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("renders BenchCard for occupied positions", () => {
    const bench = makeBench({ id: 1 });
    renderTab(
      makeContext({
        benchPositions: [{ position: 1, bench }, { position: 2 }],
      }),
    );
    expect(screen.getAllByTestId("bench-card")).toHaveLength(1);
    expect(screen.getAllByTestId("empty-bench-card")).toHaveLength(1);
  });

  it("renders PendingBenchCard for pending assignments", () => {
    const pending = new Map([[2, { externalId: "org/repo#42", issueTitle: "Fix bug" }]]);
    renderTab(
      makeContext({
        benchPositions: [{ position: 1 }, { position: 2 }],
        pendingAssignments: pending,
      }),
    );
    expect(screen.getByTestId("pending-bench-card")).toBeInTheDocument();
    expect(screen.getAllByTestId("empty-bench-card")).toHaveLength(1);
  });

  it("calls openCreateBench when EmptyBenchCard onCreateBlank fires", async () => {
    const openCreateBench = vi.fn();
    renderTab(
      makeContext({
        benchPositions: [{ position: 1 }],
        openCreateBench,
      }),
    );
    await userEvent.click(screen.getByTestId("create-blank-1"));
    expect(openCreateBench).toHaveBeenCalledOnce();
  });

  it("calls pickIssueForBench with position when EmptyBenchCard onPickIssue fires", async () => {
    const pickIssueForBench = vi.fn();
    renderTab(
      makeContext({
        benchPositions: [{ position: 3 }],
        pickIssueForBench,
      }),
    );
    await userEvent.click(screen.getByTestId("pick-issue-3"));
    expect(pickIssueForBench).toHaveBeenCalledWith(3);
  });

  it("shows empty state message when benchPositions is null and not loading", () => {
    renderTab(makeContext({ benchPositions: null, isLoading: false }));
    expect(
      screen.getByText("No bench configuration found. Check your roubo.yaml."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("bench-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("empty-bench-card")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
  });

  it("renders Benches heading", () => {
    renderTab(makeContext());
    expect(screen.getByRole("heading", { name: "Benches" })).toBeInTheDocument();
  });

  it("renders Set up bench button", () => {
    renderTab(makeContext());
    expect(screen.getByRole("button", { name: "Set up bench" })).toBeInTheDocument();
  });

  it("omits the global bench meter when no cap is set", () => {
    renderTab(makeContext());
    expect(screen.queryByLabelText(/^Global benches:/)).not.toBeInTheDocument();
  });

  it("renders the global bench meter in the header when a cap is set", () => {
    mockUseGlobalCap.mockReturnValue({
      current: 1,
      max: 2,
      isCapped: true,
      isAtCap: false,
      isOverCap: false,
    });
    renderTab(makeContext());
    expect(screen.getByLabelText("Global benches: 1 of 2")).toBeInTheDocument();
  });

  it("calls openCreateBench when Set up bench button is clicked", async () => {
    const openCreateBench = vi.fn();
    renderTab(makeContext({ openCreateBench }));
    await userEvent.click(screen.getByRole("button", { name: "Set up bench" }));
    expect(openCreateBench).toHaveBeenCalledOnce();
  });

  it("shows IssueQueuePanel when hasGitHub is true and not collapsed", () => {
    renderTab(makeContext({ hasGitHub: true, issueQueueCollapsed: false }));
    expect(screen.getByTestId("issue-queue-panel")).toBeInTheDocument();
  });

  it("hides IssueQueuePanel when hasGitHub is false", () => {
    renderTab(makeContext({ hasGitHub: false }));
    expect(screen.queryByTestId("issue-queue-panel")).not.toBeInTheDocument();
  });

  it("hides IssueQueuePanel when issueQueueCollapsed is true", () => {
    renderTab(makeContext({ hasGitHub: true, issueQueueCollapsed: true }));
    expect(screen.queryByTestId("issue-queue-panel")).not.toBeInTheDocument();
  });

  it("calls onToggleIssueQueue when collapse button in IssueQueuePanel is clicked", async () => {
    const onToggleIssueQueue = vi.fn();
    renderTab(
      makeContext({
        hasGitHub: true,
        issueQueueCollapsed: false,
        onToggleIssueQueue,
      }),
    );
    await userEvent.click(screen.getByTestId("collapse-queue"));
    expect(onToggleIssueQueue).toHaveBeenCalledOnce();
  });

  it("leaves the Set up bench button enabled when under the global cap", () => {
    mockUseGlobalCap.mockReturnValue({
      current: 1,
      max: 2,
      isCapped: true,
      isAtCap: false,
      isOverCap: false,
    });
    renderTab(makeContext());
    const button = screen.getByRole("button", { name: "Set up bench" });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toBeDisabled();
  });

  it("disables the Set up bench button with an accessible tooltip when at the global cap", async () => {
    mockUseGlobalCap.mockReturnValue({
      current: 2,
      max: 2,
      isCapped: true,
      isAtCap: true,
      isOverCap: false,
    });
    const openCreateBench = vi.fn();
    renderTab(makeContext({ openCreateBench }));
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Set up bench" });

    // aria-disabled, not the native disabled attribute, so it remains focusable.
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await user.tab();
    expect(button).toHaveFocus();

    // Tooltip is announced via aria-describedby with the exact cap-reached copy.
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "Global bench limit reached. 2 of 2 benches in use. Clear a bench to free a slot.",
    );
    expect(button).toHaveAttribute("aria-describedby", tooltip.id);

    // Pressing the disabled button does not open the create flow.
    await user.click(button);
    expect(openCreateBench).not.toHaveBeenCalled();
  });

  it("disables the Set up bench button when over the global cap", () => {
    mockUseGlobalCap.mockReturnValue({
      current: 3,
      max: 2,
      isCapped: true,
      isAtCap: true,
      isOverCap: true,
    });
    renderTab(makeContext());
    expect(screen.getByRole("button", { name: "Set up bench" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});
