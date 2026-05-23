// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { renderWithProviders } from "../test/renderWithProviders";
import ProjectSettingsTab from "./ProjectSettingsTab";
import type { RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import { useProjects } from "../hooks/useProjects";
import { useToast } from "../hooks/useToast";
import { useSettingsOverviewDraft } from "./project-settings/useSettingsOverviewDraft";

vi.mock("../hooks/useProjects", () => ({
  useProjects: vi.fn(),
}));

vi.mock("../hooks/useToast", () => ({
  useToast: vi.fn(),
}));

vi.mock("./project-settings/useSettingsOverviewDraft", () => ({
  useSettingsOverviewDraft: vi.fn(),
}));

vi.mock("./settings/SetupTile", () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="setup-tile">{projectId}</div>
  ),
}));

vi.mock("./settings/DefaultBranchTile", () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="default-branch-tile">{projectId}</div>
  ),
}));

vi.mock("./settings/PortAssignmentTile", () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="port-assignment-tile">{projectId}</div>
  ),
}));

vi.mock("./project-settings/WorkspaceSourceTile", () => ({
  WorkspaceSourceTile: ({ projectId }: { projectId: string }) => (
    <div data-testid="workspace-source-tile">{projectId}</div>
  ),
}));

vi.mock("./project-settings/AutoClearOverrideTile", () => ({
  AutoClearOverrideTile: ({ draft }: { draft: boolean | null }) => (
    <div data-testid="auto-clear-override-tile">{String(draft)}</div>
  ),
}));

vi.mock("./ProjectDefaultJigTile", () => ({
  ProjectDefaultJigTile: ({
    project,
  }: {
    project: RegisteredProject;
    draft: string | null;
    onChange: (v: string | null) => void;
    showProjectName?: boolean;
  }) => <div data-testid="jig-tile">{project.id}</div>,
  JigPickerOption: () => null,
  JigOverrideBadge: () => null,
  JigDefaultSourceLabel: () => null,
  INHERIT_JIG_ID: "__inherit__",
}));

vi.mock("./settings/DangerZoneTile", () => ({
  default: ({ projectId }: { projectId: string }) => (
    <div data-testid="danger-zone-tile">{projectId}</div>
  ),
}));

vi.mock("./project-settings/ProjectPermissionsInlineSection", () => ({
  ProjectPermissionsInlineSection: ({ projectId }: { projectId: string }) => (
    <div data-testid="permissions-inline-section">{projectId}</div>
  ),
}));

const mockJigsResult: {
  data: Array<{
    id: string;
    name: string;
    description: string;
    icon: string;
    source: string;
  }>;
  isLoading: boolean;
} = { data: [], isLoading: false };
const mockDeleteMutateAsync = vi.fn();
const mockDuplicateMutateAsync = vi.fn();

vi.mock("../hooks/useJigs", () => ({
  useJigs: () => mockJigsResult,
  useDeleteProjectJig: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
  useDuplicateProjectJig: () => ({
    mutateAsync: mockDuplicateMutateAsync,
    isPending: false,
  }),
}));

vi.mock("./jig-editor/DeleteJigDialog", () => ({
  default: ({ isOpen, jig }: { isOpen: boolean; jig: { name: string } }) =>
    isOpen ? <div data-testid="delete-jig-dialog">{jig.name}</div> : null,
}));

// Mock useBlocker so nav guard doesn't interfere with rendering
let mockBlocker = {
  state: "unblocked" as "unblocked" | "blocked",
  proceed: vi.fn(),
  reset: vi.fn(),
};
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useBlocker: () => mockBlocker,
  };
});

const mockedUseProjects = vi.mocked(useProjects);
const mockedUseToast = vi.mocked(useToast);
const mockedUseSettingsOverviewDraft = vi.mocked(useSettingsOverviewDraft);

const baseConfig = {
  project: {
    name: "my-app",
    displayName: "My App",
    type: "web" as const,
    repo: "org/my-app",
  },
  layout: { type: "monorepo" as const },
  components: {},
  ports: {},
  benches: { max: 3 },
};

const baseProject: RegisteredProject = {
  id: "my-app",
  repoPath: "/home/user/my-app",
  configValid: true,
  config: baseConfig,
  settings: DEFAULT_PROJECT_SETTINGS,
};

const defaultDraft = {
  draftWorktreeSource: DEFAULT_PROJECT_SETTINGS.worktreeSource,
  setDraftWorktreeSource: vi.fn(),
  draftJig: null as string | null,
  setDraftJig: vi.fn(),
  draftAutoClear: null as boolean | null,
  setDraftAutoClear: vi.fn(),
  originalWorktreeSource: DEFAULT_PROJECT_SETTINGS.worktreeSource,
  originalJig: null as string | null,
  originalAutoClear: null as boolean | null,
  hasAnyDirty: false,
  isWorktreeSourceDirty: false,
  isJigDirty: false,
  isAutoClearDirty: false,
  isSaving: false,
  saveErrors: [] as string[],
  save: vi.fn().mockResolvedValue({ ok: true, failed: [] }),
  discard: vi.fn(),
  justSavedRef: { current: false },
};

function LocationCapture({ onChange }: { onChange: (path: string) => void }) {
  const location = useLocation();
  onChange(location.pathname);
  return null;
}

function renderTab(projectId = "my-app") {
  let capturedPath = "";
  const result = renderWithProviders(
    <MemoryRouter initialEntries={[`/projects/${projectId}/settings`]}>
      <Routes>
        <Route path="/projects/:projectId/settings/*" element={<ProjectSettingsTab />} />
        <Route
          path="/projects/:projectId/settings/permissions"
          element={
            <LocationCapture
              onChange={(p) => {
                capturedPath = p;
              }}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { ...result, getCapturedPath: () => capturedPath };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBlocker = { state: "unblocked", proceed: vi.fn(), reset: vi.fn() };
  mockJigsResult.data = [];
  mockJigsResult.isLoading = false;

  mockedUseProjects.mockReturnValue({
    data: [baseProject],
    isLoading: false,
  } as unknown as ReturnType<typeof useProjects>);

  mockedUseToast.mockReturnValue({
    addToast: vi.fn(),
    toasts: [],
    removeToast: vi.fn(),
  } as unknown as ReturnType<typeof useToast>);

  mockedUseSettingsOverviewDraft.mockReturnValue(
    defaultDraft as unknown as ReturnType<typeof useSettingsOverviewDraft>,
  );
});

describe("ProjectSettingsTab", () => {
  it("renders the settings tile grid", () => {
    renderTab();
    expect(screen.getByTestId("project-settings-content")).toBeInTheDocument();
  });

  it("renders all tiles when project is found", () => {
    renderTab();
    expect(screen.getByTestId("setup-tile")).toBeInTheDocument();
    expect(screen.getByTestId("default-branch-tile")).toBeInTheDocument();
    expect(screen.getByTestId("port-assignment-tile")).toBeInTheDocument();
    expect(screen.getByTestId("auto-clear-override-tile")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-source-tile")).toBeInTheDocument();
    expect(screen.getByTestId("jig-tile")).toBeInTheDocument();
    expect(screen.getByTestId("danger-zone-tile")).toBeInTheDocument();
    expect(screen.getByTestId("permissions-inline-section")).toBeInTheDocument();
  });

  it("passes project id to each tile", () => {
    renderTab("my-app");
    expect(screen.getByTestId("setup-tile")).toHaveTextContent("my-app");
    expect(screen.getByTestId("default-branch-tile")).toHaveTextContent("my-app");
    expect(screen.getByTestId("port-assignment-tile")).toHaveTextContent("my-app");
    expect(screen.getByTestId("workspace-source-tile")).toHaveTextContent("my-app");
    expect(screen.getByTestId("jig-tile")).toHaveTextContent("my-app");
    expect(screen.getByTestId("danger-zone-tile")).toHaveTextContent("my-app");
    expect(screen.getByTestId("permissions-inline-section")).toHaveTextContent("my-app");
  });

  it("renders the Danger zone section heading", () => {
    renderTab();
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeInTheDocument();
  });

  it("renders the Setup section heading", () => {
    renderTab();
    expect(screen.getByRole("heading", { name: "Setup" })).toBeInTheDocument();
  });

  it("renders the Bench behaviour section heading", () => {
    renderTab();
    expect(screen.getByRole("heading", { name: "Bench behaviour" })).toBeInTheDocument();
  });

  it("renders the override affordance in the Bench behaviour heading", () => {
    renderTab();
    expect(screen.getByText(/Project overrides are marked/)).toBeInTheDocument();
    expect(screen.getByText("override", { selector: "span" })).toBeInTheDocument();
  });

  it("renders the Claude Code permissions section heading", () => {
    renderTab();
    expect(screen.getByText("Claude Code permissions")).toBeInTheDocument();
  });

  it("renders the permissions inline section component", () => {
    renderTab();
    expect(screen.getByTestId("permissions-inline-section")).toBeInTheDocument();
  });

  it("shows loading spinner while projects are loading", () => {
    mockedUseProjects.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useProjects>);
    renderTab();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it('shows "Project not found" for an unknown project id', () => {
    renderTab("unknown-id");
    expect(screen.getByText("Project not found.")).toBeInTheDocument();
  });

  it("save bar is hidden when no unsaved changes", () => {
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: false,
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    const bar = screen.getByTestId("settings-save-bar");
    expect(bar).toHaveClass("h-0", "overflow-hidden", "opacity-0");
    expect(bar).not.toHaveClass("translate-y-full");
  });

  it("save bar is visible when there are unsaved changes", () => {
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    const bar = screen.getByTestId("settings-save-bar");
    expect(bar).toHaveClass("opacity-100");
    expect(bar).not.toHaveClass("h-0", "opacity-0");
  });

  it("clicking Save calls save and addToast on success", async () => {
    const addToast = vi.fn();
    const save = vi.fn().mockResolvedValue({ ok: true, failed: [] });
    mockedUseToast.mockReturnValue({
      addToast,
      toasts: [],
      removeToast: vi.fn(),
    } as unknown as ReturnType<typeof useToast>);
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
      save,
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);

    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(save).toHaveBeenCalled();
    await vi.waitFor(() => expect(addToast).toHaveBeenCalledWith("Settings saved."));
  });

  it("clicking Save does not call addToast when save fails", async () => {
    const addToast = vi.fn();
    const save = vi.fn().mockResolvedValue({ ok: false, failed: ["Jig override"] });
    mockedUseToast.mockReturnValue({
      addToast,
      toasts: [],
      removeToast: vi.fn(),
    } as unknown as ReturnType<typeof useToast>);
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
      saveErrors: ["Jig override"],
      save,
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);

    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(save).toHaveBeenCalled();
    await vi.waitFor(() => expect(addToast).not.toHaveBeenCalled());
  });

  it("clicking Discard calls discard", async () => {
    const discard = vi.fn();
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
      discard,
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);

    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole("button", { name: "Discard" }));

    expect(discard).toHaveBeenCalled();
  });

  it("shows UnsavedChangesDialog when navigation is blocked", () => {
    mockBlocker = { state: "blocked", proceed: vi.fn(), reset: vi.fn() };
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
  });

  it("renders 'Merged into .claude/settings.local.json on bench setup' helper in the permissions section", () => {
    renderTab();
    expect(screen.getByText(".claude/settings.local.json")).toBeInTheDocument();
    expect(document.body.textContent).toContain("Merged into");
    expect(document.body.textContent).toContain("on bench setup");
  });

  it("renders 'Edit permissions' button in the permissions section header", () => {
    renderTab();
    expect(screen.getByRole("button", { name: /edit permissions/i })).toBeInTheDocument();
  });

  it("navigates to permissions editor when Edit permissions is clicked", async () => {
    const user = userEvent.setup();
    const { getCapturedPath } = renderTab("my-app");
    await user.click(screen.getByRole("button", { name: /edit permissions/i }));
    expect(getCapturedPath()).toBe("/projects/my-app/settings/permissions");
  });

  it("nests Issue type mappings inside the Jig tile", () => {
    renderTab();
    const jigTile = screen.getByRole("region", { name: "Jig" });
    expect(
      within(jigTile).getByRole("heading", {
        name: "Issue type mappings",
      }),
    ).toBeInTheDocument();
    expect(within(jigTile).getByText(/Changes write to/)).toBeInTheDocument();
  });

  it("shows the Jig tile in editing state when only issue type mappings are dirty", () => {
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
      isJigDirty: false,
      isIssueTypeMappingsDirty: true,
      draftIssueTypeMappings: { Bug: "bp-bug" },
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    const jigTile = screen.getByRole("region", { name: "Jig" });
    expect(within(jigTile).getByText("Editing")).toBeInTheDocument();
  });

  it("shows the Jig tile in editing state when only the default jig is dirty", () => {
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      hasAnyDirty: true,
      isJigDirty: true,
      isIssueTypeMappingsDirty: false,
      draftJig: "bp-default",
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    const jigTile = screen.getByRole("region", { name: "Jig" });
    expect(within(jigTile).getByText("Editing")).toBeInTheDocument();
  });

  it("shows the Override badge on the Jig tile when only the default jig is overridden", () => {
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      draftJig: "bp-default",
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    const jigTile = screen.getByRole("region", { name: "Jig" });
    expect(within(jigTile).getByText("Override")).toBeInTheDocument();
  });

  it("shows the Override badge on the Jig tile when only an issue type mapping is overridden", () => {
    mockedUseSettingsOverviewDraft.mockReturnValue({
      ...defaultDraft,
      draftIssueTypeMappings: { Bug: "bp-bug" },
    } as unknown as ReturnType<typeof useSettingsOverviewDraft>);
    renderTab();
    const jigTile = screen.getByRole("region", { name: "Jig" });
    expect(within(jigTile).getByText("Override")).toBeInTheDocument();
  });

  it("does not show the Override badge on the Jig tile when neither side is overridden", () => {
    renderTab();
    const jigTile = screen.getByRole("region", { name: "Jig" });
    expect(within(jigTile).queryByText("Override")).not.toBeInTheDocument();
  });

  describe("project custom jigs list", () => {
    it("renders the Custom jigs heading and an empty-state hint", () => {
      renderTab();
      expect(screen.getByRole("heading", { name: "Custom jigs" })).toBeInTheDocument();
      expect(screen.getByText(/No project jigs yet/i)).toBeInTheDocument();
    });

    it("links the New jig button to the project-scoped editor route", () => {
      renderTab("my-app");
      const link = screen.getByRole("link", { name: /new jig/i });
      expect(link).toHaveAttribute("href", "/projects/my-app/jigs/new");
    });

    it("renders only project-source jigs and uses project-scoped edit links", () => {
      mockJigsResult.data = [
        {
          id: "bp-app",
          name: "App jig",
          description: "from app",
          icon: "file-text",
          source: "app",
        },
        {
          id: "bp-proj",
          name: "Project jig",
          description: "from repo",
          icon: "file-text",
          source: "project",
        },
      ];
      renderTab("my-app");
      expect(screen.getByText("Project jig")).toBeInTheDocument();
      expect(screen.queryByText("App jig")).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: /Edit Project jig/i })).toHaveAttribute(
        "href",
        "/projects/my-app/jigs/edit/bp-proj",
      );
    });

    it("opens the delete dialog when Delete is clicked", async () => {
      mockJigsResult.data = [
        {
          id: "bp-proj",
          name: "Project jig",
          description: "from repo",
          icon: "file-text",
          source: "project",
        },
      ];
      const user = userEvent.setup();
      renderTab();
      await user.click(screen.getByRole("button", { name: /Delete Project jig/i }));
      expect(screen.getByTestId("delete-jig-dialog")).toHaveTextContent("Project jig");
    });
  });
});
