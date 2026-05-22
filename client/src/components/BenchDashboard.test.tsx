// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Routes,
  Route,
  Navigate,
  createMemoryRouter,
  RouterProvider,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { Bench, ProjectIntegrationState, RegisteredProject } from "@roubo/shared";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useBlocker: () => ({
      state: "unblocked",
      proceed: vi.fn(),
      reset: vi.fn(),
    }),
  };
});

vi.mock("./project-settings/useSettingsOverviewDraft", () => ({
  useSettingsOverviewDraft: vi.fn(() => ({
    draftWorktreeSource: { branchFromDefault: true, pullLatest: true },
    setDraftWorktreeSource: vi.fn(),
    draftBlueprint: null,
    setDraftBlueprint: vi.fn(),
    draftAutoClear: null,
    setDraftAutoClear: vi.fn(),
    originalWorktreeSource: { branchFromDefault: true, pullLatest: true },
    originalBlueprint: null,
    originalAutoClear: null,
    hasAnyDirty: false,
    isWorktreeSourceDirty: false,
    isBlueprintDirty: false,
    isAutoClearDirty: false,
    isSaving: false,
    saveErrors: [],
    save: vi.fn().mockResolvedValue({ ok: true, failed: [] }),
    discard: vi.fn(),
    justSavedRef: { current: false },
  })),
}));

const dndCallbacks = vi.hoisted(() => ({
  onDragStart: undefined as ((event: unknown) => void) | undefined,
  onDragEnd: undefined as ((event: unknown) => void) | undefined,
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
  }: {
    children: React.ReactNode;
    onDragStart: (e: unknown) => void;
    onDragEnd: (e: unknown) => void;
  }) => {
    dndCallbacks.onDragStart = onDragStart;
    dndCallbacks.onDragEnd = onDragEnd;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../hooks/useProjects");
vi.mock("../hooks/useBenches");
vi.mock("../hooks/useToast");
vi.mock("../hooks/useBlueprints", () => ({
  useBlueprints: vi.fn(() => ({ data: [], isLoading: false })),
  useGlobalBlueprints: vi.fn(() => ({ data: [] })),
  useDeleteGlobalBlueprint: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useDeleteProjectBlueprint: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useDuplicateProjectBlueprint: vi.fn(() => ({
    mutateAsync: vi.fn(),
    isPending: false,
  })),
  useDuplicateGlobalBlueprint: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
}));
vi.mock("../hooks/useProjectDefaultBlueprint", () => ({
  useProjectDefaultBlueprint: vi.fn(() => ({
    data: undefined,
    isLoading: false,
  })),
  useUpdateProjectDefaultBlueprint: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  })),
}));
vi.mock("./BenchCard", () => ({
  default: ({ bench }: { bench: Bench }) => <div data-testid="bench-card">{bench.id}</div>,
}));
vi.mock("./EmptyBenchCard", () => ({
  default: ({
    position,
    onCreateBlank,
    onPickIssue,
  }: {
    position: number;
    onCreateBlank: () => void;
    onPickIssue: (position: number) => void;
  }) => (
    <div data-testid="empty-bench-card">
      {position}
      <button data-testid={`pick-issue-${position}`} onClick={() => onPickIssue(position)}>
        Pick Issue
      </button>
      <button data-testid={`create-blank-${position}`} onClick={onCreateBlank}>
        Create Blank
      </button>
    </div>
  ),
}));
vi.mock("./PendingBenchCard", () => ({
  default: () => <div data-testid="pending-bench-card" />,
}));
vi.mock("./CreateBenchModal", () => ({
  default: ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) =>
    isOpen ? (
      <div data-testid="create-modal-open">
        <button data-testid="create-modal-close" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));
vi.mock("./IssueQueuePanel", () => ({
  default: ({
    pendingIssueExternalIds,
    initialFilters,
    onFiltersChange,
    initialGrouping,
    onGroupingChange,
    onCollapse,
    projectId,
  }: {
    pendingIssueExternalIds: Set<string>;
    initialFilters?: {
      type: string;
      labels: Set<string>;
      search: string;
    };
    onFiltersChange?: (
      projectId: string,
      filters: {
        type: string;
        labels: Set<string>;
        search: string;
      },
    ) => void;
    initialGrouping?: { groupBy: string };
    onGroupingChange?: (projectId: string, grouping: { groupBy: string }) => void;
    onCollapse?: () => void;
    projectId: string;
  }) => (
    <div
      data-testid="issue-queue-panel"
      data-pending={JSON.stringify([...pendingIssueExternalIds])}
      data-initial-type={initialFilters?.type ?? ""}
      data-initial-group-by={initialGrouping?.groupBy ?? "none"}
    >
      {onCollapse && (
        <button data-testid="collapse-queue" onClick={onCollapse}>
          Collapse
        </button>
      )}
      <button
        data-testid="set-filter"
        onClick={() =>
          onFiltersChange?.(projectId, {
            type: "Bug",
            labels: new Set(),
            search: "",
          })
        }
      >
        Set Filter
      </button>
      <button
        data-testid="set-grouping"
        onClick={() => onGroupingChange?.(projectId, { groupBy: "type" })}
      >
        Set Grouping
      </button>
    </div>
  ),
}));
vi.mock("./IssuePickerModal", () => ({
  default: ({
    isOpen,
    onSelect,
    onClose,
  }: {
    isOpen: boolean;
    onSelect: (n: number, t: string) => void;
    onClose: () => void;
  }) =>
    isOpen ? (
      <div data-testid="issue-picker">
        <button data-testid="issue-picker-select" onClick={() => onSelect(42, "Issue 42")}>
          Select 42
        </button>
        <button data-testid="issue-picker-close" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));
vi.mock("./BranchConflictDialog", () => ({
  default: ({
    isOpen,
    onClose,
    onResume,
    onCreateNew,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onResume: () => void;
    onCreateNew: () => void;
  }) =>
    isOpen ? (
      <div data-testid="conflict-dialog">
        <button data-testid="conflict-close" onClick={onClose}>
          Close
        </button>
        <button data-testid="conflict-resume" onClick={onResume}>
          Resume
        </button>
        <button data-testid="conflict-new" onClick={onCreateNew}>
          Create New
        </button>
      </div>
    ) : null,
}));

vi.mock("../hooks/useGitHubAuth");
vi.mock("./GitHubErrorState", () => ({
  default: ({ error }: { error: unknown }) =>
    error ? <div data-testid="github-error-state" /> : null,
}));
vi.mock("./settings/DangerZoneTile", () => ({
  default: () => <div data-testid="danger-zone-tile" />,
}));
vi.mock("./RegisterProjectModalProvider", () => ({
  RegisterProjectModalProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useRegisterProjectModal: () => ({ open: vi.fn() }),
}));
vi.mock("./ProjectTile", () => ({
  default: ({
    project,
  }: {
    project: { id: string; config?: { project?: { displayName?: string } } };
  }) => <div data-testid="project-tile">{project.config?.project?.displayName ?? project.id}</div>,
}));
vi.mock("./RegisterProjectTile", () => ({
  default: () => <div data-testid="register-project-tile">Register project</div>,
}));
vi.mock("../hooks/useProjectIntegration", () => ({
  useProjectIntegration: vi.fn(() => ({ data: undefined })),
}));
vi.mock("./MissingPluginDialog", () => ({
  default: ({
    projectId,
    pluginId,
    onSkip,
  }: {
    projectId: string;
    pluginId: string;
    onSkip: () => void;
  }) => (
    <div data-testid="missing-plugin-dialog" data-project-id={projectId} data-plugin-id={pluginId}>
      <button data-testid="missing-plugin-dialog-skip" onClick={onSkip}>
        Skip for now
      </button>
    </div>
  ),
}));

import { useProjects } from "../hooks/useProjects";
import { useProjectBenches, useCreateBench } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";
import { useGitHubAuth } from "../hooks/useGitHubAuth";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import BenchDashboard from "./BenchDashboard";
import BenchesTab from "./BenchesTab";
import ProjectSettingsTab from "./ProjectSettingsTab";

const mockedUseProjects = vi.mocked(useProjects);
const mockedUseProjectBenches = vi.mocked(useProjectBenches);
const mockedUseCreateBench = vi.mocked(useCreateBench);
const mockedUseToast = vi.mocked(useToast);
const mockedUseGitHubAuth = vi.mocked(useGitHubAuth);
const mockedUseProjectIntegration = vi.mocked(useProjectIntegration);

type MutateOptions = {
  onSuccess?: (result: unknown) => void;
  onError?: (err: unknown) => void;
};

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "proj-1",
    repoPath: "/repos/proj-1",
    configValid: true,
    config: {
      project: {
        displayName: "My Project",
        name: "my-project",
        type: "web",
        repo: "",
      },
      layout: { type: "single-repo" },
      components: {},
      ports: {},
      benches: { max: 3 },
    } as RegisteredProject["config"],
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-1",
    branch: "feat/my-feature",
    workspacePath: "/workspaces/proj-1/bench-1",
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

function stubDefaults({
  projects,
  benches,
  projectsLoading = false,
  benchesLoading = false,
  githubConnected = true,
  integration,
}: {
  projects?: RegisteredProject[];
  benches?: Bench[];
  projectsLoading?: boolean;
  benchesLoading?: boolean;
  githubConnected?: boolean;
  integration?: ProjectIntegrationState;
} = {}) {
  let capturedOptions: MutateOptions = {};
  const createMutate = vi.fn((_args: unknown, options?: MutateOptions) => {
    if (options) capturedOptions = options;
  });
  let capturedToastOptions: {
    action?: { onPress: () => void };
    onExpire?: () => void;
  } = {};
  const addToast = vi.fn((_message: string, options?: typeof capturedToastOptions) => {
    if (options) capturedToastOptions = options;
  });
  mockedUseProjects.mockReturnValue({
    data: projects,
    isLoading: projectsLoading,
  } as unknown as UseQueryResult<RegisteredProject[]>);
  mockedUseProjectBenches.mockReturnValue({
    data: benches,
    isLoading: benchesLoading,
  } as unknown as UseQueryResult<Bench[]>);
  mockedUseCreateBench.mockReturnValue({
    mutate: createMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useCreateBench>);
  mockedUseToast.mockReturnValue({ addToast } as unknown as ReturnType<typeof useToast>);
  mockedUseGitHubAuth.mockReturnValue({
    status: { connected: githubConnected },
    isLoading: false,
    error: null,
  });
  mockedUseProjectIntegration.mockReturnValue({
    data: integration,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useProjectIntegration>);
  return {
    createMutate,
    addToast,
    getCapturedOptions: () => capturedOptions,
    getCapturedToastOptions: () => capturedToastOptions,
  };
}

function renderDashboard(path = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/projects/:projectId" element={<BenchDashboard />}>
            <Route index element={<BenchesTab />} />
            <Route path="settings/*" element={<ProjectSettingsTab />} />
            <Route path="*" element={<Navigate to=".." relative="path" replace />} />
          </Route>
          <Route path="/" element={<BenchDashboard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderWithNavigation(initialPath: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId",
        element: <BenchDashboard />,
        children: [
          { index: true, element: <BenchesTab /> },
          { path: "settings/*", element: <ProjectSettingsTab /> },
          { path: "*", element: <Navigate to=".." relative="path" replace /> },
        ],
      },
      { path: "/", element: <BenchDashboard /> },
    ],
    { initialEntries: [initialPath] },
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

describe("BenchDashboard", () => {
  describe("All Projects view (no projectId)", () => {
    it("shows loading indicator while data is loading", () => {
      stubDefaults({ projectsLoading: true });
      renderDashboard();
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("shows RegisterProjectTile as empty state when no projects exist", () => {
      stubDefaults({ projects: [], benches: [] });
      renderDashboard();
      expect(screen.getByTestId("register-project-tile")).toBeInTheDocument();
    });

    it("renders a ProjectTile for each registered project", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard();
      expect(screen.getByTestId("project-tile")).toBeInTheDocument();
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    it("renders RegisterProjectTile alongside project tiles", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard();
      expect(screen.getByTestId("project-tile")).toBeInTheDocument();
      expect(screen.getByTestId("register-project-tile")).toBeInTheDocument();
    });

    it("renders All Projects title when no projectId", () => {
      stubDefaults({ projects: [], benches: [] });
      renderDashboard();
      expect(screen.getByText("All Projects")).toBeInTheDocument();
    });

    it("renders Register project primary button in header", () => {
      stubDefaults({ projects: [], benches: [] });
      renderDashboard();
      expect(screen.getByRole("button", { name: "Register project" })).toBeInTheDocument();
    });
  });

  describe("Single project view", () => {
    it("renders Benches tab content when project data is loaded", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      expect(screen.getByText("Set up bench")).toBeInTheDocument();
    });

    it("renders BenchCard for occupied positions and EmptyBenchCard for empty ones", () => {
      stubDefaults({
        projects: [makeProject()], // max=3
        benches: [makeBench({ id: 1 })],
      });
      renderDashboard("/projects/proj-1");
      expect(screen.getAllByTestId("bench-card")).toHaveLength(1);
      expect(screen.getAllByTestId("empty-bench-card")).toHaveLength(2);
    });

    it("renders Set up bench button", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      expect(screen.getByText("Set up bench")).toBeInTheDocument();
    });

    it("shows loading indicator while data is loading", () => {
      stubDefaults({ projects: [makeProject()], benchesLoading: true });
      renderDashboard("/projects/proj-1");
      expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    it("opens issue picker when onPickIssue is triggered from EmptyBenchCard", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      expect(screen.getByTestId("issue-picker")).toBeInTheDocument();
    });

    it("calls createBench when issue is selected from IssuePickerModal (after toast expires)", async () => {
      const { createMutate, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "proj-1", issueNumber: 42 }),
        expect.any(Object),
      );
    });

    it("adds issue to pending when selected from IssuePickerModal", async () => {
      const projectWithGitHub = makeProject({
        config: {
          ...makeProject().config,
          project: {
            displayName: "My Project",
            name: "my-project",
            type: "web",
            repo: "https://github.com/org/repo",
          },
        } as RegisteredProject["config"],
      });
      stubDefaults({ projects: [projectWithGitHub], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      const panel = screen.getByTestId("issue-queue-panel");
      expect(JSON.parse(panel.dataset.pending ?? "[]")).toContain("42");
    });

    it("shows branch conflict dialog when createBench returns conflict", async () => {
      const { getCapturedOptions, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      await act(async () => {
        getCapturedOptions().onSuccess?.({
          status: "conflict",
          branchConflict: {
            branchExists: true,
            workspaceExists: false,
            branchName: "feat/conflict",
          },
        });
      });
      expect(await screen.findByTestId("conflict-dialog")).toBeInTheDocument();
    });

    it("calls createBench with resume resolution when conflict dialog Resume is clicked", async () => {
      const { createMutate, getCapturedOptions, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      await act(async () => {
        getCapturedOptions().onSuccess?.({
          status: "conflict",
          branchConflict: {
            branchExists: true,
            workspaceExists: false,
            branchName: "feat/conflict",
          },
        });
      });
      await userEvent.click(await screen.findByTestId("conflict-resume"));
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          branchConflictResolution: "resume",
        }),
        expect.any(Object),
      );
    });

    it("calls createBench with new resolution when conflict dialog Create New is clicked", async () => {
      const { createMutate, getCapturedOptions, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      await act(async () => {
        getCapturedOptions().onSuccess?.({
          status: "conflict",
          branchConflict: {
            branchExists: true,
            workspaceExists: false,
            branchName: "feat/conflict",
          },
        });
      });
      await userEvent.click(await screen.findByTestId("conflict-new"));
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumber: 42,
          branchConflictResolution: "new",
        }),
        expect.any(Object),
      );
    });

    it("opens CreateBenchModal when Set up bench button is clicked", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByText("Set up bench"));
      expect(screen.getByTestId("create-modal-open")).toBeInTheDocument();
    });

    it("opens CreateBenchModal when Create Blank is triggered from EmptyBenchCard", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("create-blank-1"));
      expect(screen.getByTestId("create-modal-open")).toBeInTheDocument();
    });

    it("closes CreateBenchModal when onClose is called", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByText("Set up bench"));
      expect(screen.getByTestId("create-modal-open")).toBeInTheDocument();
      await userEvent.click(screen.getByTestId("create-modal-close"));
      expect(screen.queryByTestId("create-modal-open")).not.toBeInTheDocument();
    });

    it("closes IssuePickerModal when onClose is called", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      expect(screen.getByTestId("issue-picker")).toBeInTheDocument();
      await userEvent.click(screen.getByTestId("issue-picker-close"));
      expect(screen.queryByTestId("issue-picker")).not.toBeInTheDocument();
    });

    it("closes conflict dialog when onClose is called", async () => {
      const { getCapturedOptions, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      await act(async () => {
        getCapturedOptions().onSuccess?.({
          status: "conflict",
          branchConflict: {
            branchExists: true,
            workspaceExists: false,
            branchName: "feat/conflict",
          },
        });
      });
      await userEvent.click(await screen.findByTestId("conflict-close"));
      expect(screen.queryByTestId("conflict-dialog")).not.toBeInTheDocument();
    });

    it("clears pending and surfaces error toast when createBench fails", async () => {
      const { addToast, getCapturedOptions, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      addToast.mockClear();
      await act(async () => {
        getCapturedOptions().onError?.(new Error("Issue is blocked by unresolved dependencies"));
      });
      expect(screen.queryByTestId("pending-bench-card")).not.toBeInTheDocument();
      expect(addToast).toHaveBeenCalledWith(
        "Issue is blocked by unresolved dependencies",
        expect.objectContaining({ duration: 8000 }),
      );
    });

    it("uses fallback toast message when onError receives a non-Error value", async () => {
      const { addToast, getCapturedOptions, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      addToast.mockClear();
      await act(async () => {
        getCapturedOptions().onError?.("not an error");
      });
      expect(addToast).toHaveBeenCalledWith(
        "Failed to create bench",
        expect.objectContaining({ duration: 8000 }),
      );
    });

    it("shows pending bench card when issue is selected from IssuePickerModal", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      expect(screen.getByTestId("pending-bench-card")).toBeInTheDocument();
    });

    it("cancels issue pick when toast cancel action is pressed", async () => {
      const { getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      await userEvent.click(screen.getByTestId("pick-issue-1"));
      await userEvent.click(screen.getByTestId("issue-picker-select"));
      expect(screen.getByTestId("pending-bench-card")).toBeInTheDocument();
      act(() => {
        getCapturedToastOptions().action?.onPress();
      });
      expect(screen.queryByTestId("pending-bench-card")).not.toBeInTheDocument();
    });

    it("fires handleDragEnd and adds pending card when drag drops onto empty position", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      const dragEndEvent = {
        active: {
          data: {
            current: {
              issue: { externalId: "7", title: "Drag test", integrationId: "github-com" },
            },
          },
        },
        over: { data: { current: { position: 2 } } },
      };
      act(() => {
        dndCallbacks.onDragEnd?.(dragEndEvent);
      });
      expect(screen.getByTestId("pending-bench-card")).toBeInTheDocument();
    });

    it("cancels drag when toast cancel action is pressed", async () => {
      const { getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      act(() => {
        dndCallbacks.onDragEnd?.({
          active: {
            data: {
              current: {
                issue: { externalId: "8", title: "Cancel test", integrationId: "github-com" },
              },
            },
          },
          over: { data: { current: { position: 1 } } },
        });
      });
      expect(screen.getByTestId("pending-bench-card")).toBeInTheDocument();
      act(() => {
        getCapturedToastOptions().action?.onPress();
      });
      expect(screen.queryByTestId("pending-bench-card")).not.toBeInTheDocument();
    });

    it("calls createBench when toast expires without cancel", async () => {
      const { createMutate, getCapturedToastOptions } = stubDefaults({
        projects: [makeProject()],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      act(() => {
        dndCallbacks.onDragEnd?.({
          active: {
            data: {
              current: {
                issue: { externalId: "9", title: "Expire test", integrationId: "github-com" },
              },
            },
          },
          over: { data: { current: { position: 1 } } },
        });
      });
      act(() => {
        getCapturedToastOptions().onExpire?.();
      });
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "proj-1", issueNumber: 9 }),
        expect.any(Object),
      );
    });

    it("fires handleDragEnd early return when over is null", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      expect(() => dndCallbacks.onDragEnd?.({ active: {}, over: null })).not.toThrow();
    });

    it("fires handleDragStart and sets dragging item", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      act(() => {
        dndCallbacks.onDragStart?.({
          active: {
            data: {
              current: { item: { issue: { number: 5, title: "Drag" } } },
            },
          },
        });
      });
    });

    it("toggles issue queue collapsed state when panel collapse button is clicked", async () => {
      stubDefaults({
        projects: [
          makeProject({
            config: {
              ...makeProject().config,
              project: {
                displayName: "My Project",
                name: "my-project",
                type: "web",
                repo: "https://github.com/org/repo",
              },
            } as RegisteredProject["config"],
          }),
        ],
        benches: [],
      });
      renderDashboard("/projects/proj-1");
      // Cut list starts visible — collapse button is in the IssueQueuePanel
      await userEvent.click(screen.getByTestId("collapse-queue"));
      // After collapse, expand button appears in the tab nav
      expect(screen.getByLabelText("Show cut list")).toBeInTheDocument();
      expect(screen.queryByTestId("issue-queue-panel")).not.toBeInTheDocument();
    });
  });

  describe("All Projects view button interactions", () => {
    it("Register project header button is present in all states", () => {
      stubDefaults({ projects: [], benches: [] });
      renderDashboard();
      expect(screen.getByRole("button", { name: "Register project" })).toBeInTheDocument();
    });

    it("shows RegisterProjectTile in grid alongside project tiles", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard();
      expect(screen.getByTestId("project-tile")).toBeInTheDocument();
      expect(screen.getByTestId("register-project-tile")).toBeInTheDocument();
    });
  });

  describe("Filter state persistence", () => {
    function makeProjectWithGitHub(id: string): RegisteredProject {
      return makeProject({
        id,
        config: {
          ...makeProject().config,
          project: {
            displayName: `Project ${id}`,
            name: id,
            type: "web",
            repo: "",
            github: { project: 1 },
          },
        } as RegisteredProject["config"],
      });
    }

    it("preserves filter state when switching to a different project and back", async () => {
      stubDefaults({
        projects: [makeProjectWithGitHub("proj-1"), makeProjectWithGitHub("proj-2")],
        benches: [],
      });
      const { router } = renderWithNavigation("/projects/proj-1");

      // Set a filter on proj-1
      await userEvent.click(screen.getByTestId("set-filter"));

      // Switch to proj-2
      await act(async () => {
        await router.navigate("/projects/proj-2");
      });

      // Switch back to proj-1
      await act(async () => {
        await router.navigate("/projects/proj-1");
      });

      // Filters for proj-1 should be restored
      expect(screen.getByTestId("issue-queue-panel").dataset.initialType).toBe("Bug");
    });

    it("gives each project independent filter state", async () => {
      stubDefaults({
        projects: [makeProjectWithGitHub("proj-1"), makeProjectWithGitHub("proj-2")],
        benches: [],
      });
      const { router } = renderWithNavigation("/projects/proj-1");

      // Set a filter on proj-1
      await userEvent.click(screen.getByTestId("set-filter"));

      // Switch to proj-2 — should start with empty filters
      await act(async () => {
        await router.navigate("/projects/proj-2");
      });

      expect(screen.getByTestId("issue-queue-panel").dataset.initialType).toBe("");
    });

    it("preserves grouping state when switching to a different project and back", async () => {
      stubDefaults({
        projects: [makeProjectWithGitHub("proj-1"), makeProjectWithGitHub("proj-2")],
        benches: [],
      });
      const { router } = renderWithNavigation("/projects/proj-1");

      // Set a grouping on proj-1
      await userEvent.click(screen.getByTestId("set-grouping"));

      // Switch to proj-2
      await act(async () => {
        await router.navigate("/projects/proj-2");
      });

      // Switch back to proj-1
      await act(async () => {
        await router.navigate("/projects/proj-1");
      });

      // Grouping for proj-1 should be restored
      expect(screen.getByTestId("issue-queue-panel").dataset.initialGroupBy).toBe("type");
    });

    it("gives each project independent grouping state", async () => {
      stubDefaults({
        projects: [makeProjectWithGitHub("proj-1"), makeProjectWithGitHub("proj-2")],
        benches: [],
      });
      const { router } = renderWithNavigation("/projects/proj-1");

      // Set a grouping on proj-1
      await userEvent.click(screen.getByTestId("set-grouping"));

      // Switch to proj-2 — should start with no grouping
      await act(async () => {
        await router.navigate("/projects/proj-2");
      });

      expect(screen.getByTestId("issue-queue-panel").dataset.initialGroupBy).toBe("none");
    });
  });

  describe("sub-tab navigation", () => {
    function makeProjectWithGitHub(): RegisteredProject {
      return makeProject({
        config: {
          ...makeProject().config,
          project: {
            displayName: "My Project",
            name: "my-project",
            type: "web",
            repo: "https://github.com/org/repo",
          },
        } as RegisteredProject["config"],
      });
    }

    it("Benches NavLink is active (aria-current=page) at /projects/proj-1", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      expect(screen.getByRole("link", { name: "Benches" })).toHaveAttribute("aria-current", "page");
      expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute(
        "aria-current",
        "page",
      );
    });

    it("Settings NavLink is active (aria-current=page) at /projects/proj-1/settings", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1/settings");
      expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByRole("link", { name: "Benches" })).not.toHaveAttribute(
        "aria-current",
        "page",
      );
    });

    it("Settings NavLink is active at a settings sub-path (/projects/proj-1/settings/setup)", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1/settings/setup");
      // The breadcrumb also renders a "Settings" link; the nav-tab link comes first in DOM order.
      const [navTabLink, breadcrumbLink] = screen.getAllByRole("link", {
        name: "Settings",
      });
      expect(navTabLink).toHaveAttribute("aria-current", "page");
      expect(breadcrumbLink).not.toHaveAttribute("aria-current");
    });

    it("renders bench grid container on Benches tab", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1");
      expect(screen.queryByText("Setup")).not.toBeInTheDocument();
    });

    it("renders settings tile grid on Settings tab", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1/settings");
      expect(screen.getByText("Setup")).toBeInTheDocument();
    });

    it("hides Set up bench button on Settings tab", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1/settings");
      expect(screen.queryByText("Set up bench")).not.toBeInTheDocument();
    });

    it("shows IssueQueuePanel on Benches tab when hasGitHub", () => {
      stubDefaults({ projects: [makeProjectWithGitHub()], benches: [] });
      renderDashboard("/projects/proj-1");
      expect(screen.getByTestId("issue-queue-panel")).toBeInTheDocument();
    });

    it("hides IssueQueuePanel on Settings tab", () => {
      stubDefaults({ projects: [makeProjectWithGitHub()], benches: [] });
      renderDashboard("/projects/proj-1/settings");
      expect(screen.queryByTestId("issue-queue-panel")).not.toBeInTheDocument();
    });

    it("preserves tab nav when switching from Benches to Settings", async () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      const { router } = renderWithNavigation("/projects/proj-1");
      expect(screen.getByRole("link", { name: "Benches" })).toBeInTheDocument();
      await act(async () => {
        await router.navigate("/projects/proj-1/settings");
      });
      expect(screen.getByRole("link", { name: "Benches" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
    });

    it("hides panel toggle buttons on Settings tab", () => {
      stubDefaults({ projects: [makeProjectWithGitHub()], benches: [] });
      renderDashboard("/projects/proj-1/settings");
      // IssueQueuePanel not rendered on Settings tab — no collapse button
      expect(screen.queryByTestId("collapse-queue")).not.toBeInTheDocument();
      // Tab nav expand button only shows when collapsed — not shown here (not collapsed + on settings)
      expect(screen.queryByLabelText("Show cut list")).not.toBeInTheDocument();
    });

    it("redirects unknown child paths to the Benches tab", () => {
      stubDefaults({ projects: [makeProject()], benches: [] });
      renderDashboard("/projects/proj-1/nonexistent");
      // The catch-all child route redirects to the index (Benches), so the settings
      // tile grid must not be present and the bench grid must be rendered instead.
      expect(screen.queryByText("Setup")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("empty-bench-card")).toHaveLength(3);
    });
  });

  describe("not-connected GitHub banner", () => {
    const projectWithRepo = makeProject({
      config: {
        project: {
          displayName: "My Project",
          name: "my-project",
          type: "web",
          repo: "org/repo",
        },
        layout: { type: "single-repo" },
        components: {},
        ports: {},
        benches: { max: 3 },
      } as RegisteredProject["config"],
    });

    it("shows banner in All Projects view when GitHub is disconnected and a project has a repo", () => {
      stubDefaults({
        projects: [projectWithRepo],
        benches: [],
        githubConnected: false,
      });
      renderDashboard("/");
      expect(screen.getByTestId("github-error-state")).toBeTruthy();
    });

    it("hides banner in All Projects view when GitHub is connected", () => {
      stubDefaults({
        projects: [projectWithRepo],
        benches: [],
        githubConnected: true,
      });
      renderDashboard("/");
      expect(screen.queryByTestId("github-error-state")).toBeNull();
    });

    it("hides banner in All Projects view when no projects have a repo", () => {
      const projectNoRepo = makeProject();
      stubDefaults({
        projects: [projectNoRepo],
        benches: [],
        githubConnected: false,
      });
      renderDashboard("/");
      expect(screen.queryByTestId("github-error-state")).toBeNull();
    });

    it("shows banner in per-project view when project has a repo and GitHub is disconnected", () => {
      stubDefaults({
        projects: [projectWithRepo],
        benches: [],
        githubConnected: false,
      });
      renderDashboard("/projects/proj-1");
      expect(screen.getByTestId("github-error-state")).toBeTruthy();
    });

    it("hides banner in per-project view when GitHub is connected", () => {
      stubDefaults({
        projects: [projectWithRepo],
        benches: [],
        githubConnected: true,
      });
      renderDashboard("/projects/proj-1");
      expect(screen.queryByTestId("github-error-state")).toBeNull();
    });

    it("hides banner in per-project view when the project has no repo configured", () => {
      const projectNoRepo = makeProject();
      stubDefaults({
        projects: [projectNoRepo],
        benches: [],
        githubConnected: false,
      });
      renderDashboard("/projects/proj-1");
      expect(screen.queryByTestId("github-error-state")).toBeNull();
    });
  });

  describe("missing-plugin prompt", () => {
    const missingIntegration: ProjectIntegrationState = {
      effective: { plugin: "jira-self-hosted", pluginSource: "https://example.com/p.git" },
      committed: { plugin: "jira-self-hosted", pluginSource: "https://example.com/p.git" },
      override: null,
      plugin: { id: "jira-self-hosted", installed: false, status: null, manifest: null },
      captionKey: "yaml-only",
    };

    it("renders MissingPluginDialog when integration plugin is not installed", () => {
      stubDefaults({
        projects: [makeProject()],
        benches: [],
        integration: missingIntegration,
      });
      renderDashboard("/projects/proj-1");
      const dialog = screen.getByTestId("missing-plugin-dialog");
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute("data-plugin-id", "jira-self-hosted");
    });

    it("does not render the dialog when no plugin is referenced", () => {
      stubDefaults({
        projects: [makeProject()],
        benches: [],
        integration: {
          effective: {},
          committed: null,
          override: null,
          plugin: null,
          captionKey: "none",
        },
      });
      renderDashboard("/projects/proj-1");
      expect(screen.queryByTestId("missing-plugin-dialog")).toBeNull();
    });

    it("does not render the dialog when the plugin is installed", () => {
      stubDefaults({
        projects: [makeProject()],
        benches: [],
        integration: {
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
      });
      renderDashboard("/projects/proj-1");
      expect(screen.queryByTestId("missing-plugin-dialog")).toBeNull();
    });

    it("dismisses the dialog after Skip and keeps it dismissed for the session", async () => {
      const user = userEvent.setup();
      stubDefaults({
        projects: [makeProject()],
        benches: [],
        integration: missingIntegration,
      });
      renderDashboard("/projects/proj-1");
      expect(screen.getByTestId("missing-plugin-dialog")).toBeInTheDocument();
      await user.click(screen.getByTestId("missing-plugin-dialog-skip"));
      expect(screen.queryByTestId("missing-plugin-dialog")).toBeNull();
    });
  });
});
