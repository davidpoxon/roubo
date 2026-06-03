// @vitest-environment jsdom
//
// Regression guard for the "Use app default" jig-clear path. Clearing a
// selected project default jig (jig id -> null) must not throw: the fix lives
// in ProjectDefaultJigTile, which coerces the cleared value to INHERIT_JIG_ID
// before handing it to the React Aria RadioGroup, so the picker never receives
// a null value. These tests lock that behaviour in rather than reproduce a
// live crash. Unlike ProjectSettingsTab.test.tsx, this suite keeps the REAL
// useSettingsOverviewDraft, ProjectDefaultJigTile, SettingsSaveBar and
// useBlocker (in a data router, as in production) so the real dirty-transition
// path is exercised. Only data hooks and unrelated sibling tiles are mocked.
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { RegisteredProject } from "@roubo/shared";
import { DEFAULT_PROJECT_SETTINGS } from "@roubo/shared";
import ProjectSettingsTab from "./ProjectSettingsTab";
import { useProjects } from "../hooks/useProjects";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useToast } from "../hooks/useToast";
import { useJigs } from "../hooks/useJigs";
import { useProjectDefaultJig, useUpdateProjectDefaultJig } from "../hooks/useProjectDefaultJig";
import { useProjectSettings } from "../hooks/useProjectSettings";
import {
  useIssueTypes,
  useIssueTypeMappings,
  useUpdateIssueTypeMappings,
} from "../hooks/useIssueTypes";
import { useUpdateProjectBenchOverrides } from "../hooks/useProjectBenchOverrides";

// Unrelated sibling tiles: stub to keep the surface focused on the jig path.
vi.mock("./IssueSourceTile", () => ({ default: () => <div data-testid="issue-source-tile" /> }));
vi.mock("./settings/SetupTile", () => ({ default: () => <div data-testid="setup-tile" /> }));
vi.mock("./settings/DefaultBranchTile", () => ({
  default: () => <div data-testid="branch-tile" />,
}));
vi.mock("./settings/PortAssignmentTile", () => ({
  default: () => <div data-testid="port-tile" />,
}));
vi.mock("./settings/DangerZoneTile", () => ({ default: () => <div data-testid="danger-tile" /> }));
vi.mock("./project-settings/WorkspaceSourceTile", () => ({
  WorkspaceSourceTile: () => <div data-testid="ws-tile" />,
}));
vi.mock("./project-settings/AutoClearOverrideTile", () => ({
  AutoClearOverrideTile: () => <div data-testid="autoclear-tile" />,
}));
vi.mock("./project-settings/EnforceIssueDependenciesOverrideTile", () => ({
  EnforceIssueDependenciesOverrideTile: () => <div data-testid="enforce-tile" />,
}));
vi.mock("./project-settings/WorkUnitAutoClearOverrideTile", () => ({
  WorkUnitAutoClearOverrideTile: () => <div data-testid="wu-tile" />,
}));
vi.mock("./project-settings/ProjectPermissionsInlineSection", () => ({
  ProjectPermissionsInlineSection: () => <div data-testid="perms-tile" />,
}));

// Data hooks: mocked. The draft hook, the jig tile, the save bar and useBlocker
// are intentionally NOT mocked.
vi.mock("../hooks/useProjects", () => ({ useProjects: vi.fn() }));
vi.mock("../hooks/useProjectIntegration", () => ({ useProjectIntegration: vi.fn() }));
vi.mock("../hooks/useToast", () => ({ useToast: vi.fn() }));
vi.mock("../hooks/useJigs", () => ({
  useJigs: vi.fn(),
  useDeleteProjectJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDuplicateProjectJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../hooks/useProjectDefaultJig", () => ({
  useProjectDefaultJig: vi.fn(),
  useUpdateProjectDefaultJig: vi.fn(),
}));
vi.mock("../hooks/useProjectSettings", () => ({ useProjectSettings: vi.fn() }));
vi.mock("../hooks/useIssueTypes", () => ({
  useIssueTypes: vi.fn(),
  useIssueTypeMappings: vi.fn(),
  useUpdateIssueTypeMappings: vi.fn(),
}));
vi.mock("../hooks/useProjectBenchOverrides", () => ({ useUpdateProjectBenchOverrides: vi.fn() }));

const PROJECT_ID = "responda";
const SELECTED_JIG = "responda-default";

// responda-like: meta-repo with a specific project default jig set.
const project: RegisteredProject = {
  id: PROJECT_ID,
  repoPath: "/Users/x/responda",
  configValid: true,
  config: {
    project: { name: "responda", displayName: "responda", repo: "intentional-au/responda" },
    layout: { type: "meta-repo" as const, submodules: {} },
    components: {},
    ports: {},
    benches: { max: 3 },
    jigs: { defaultJig: SELECTED_JIG },
  },
  settings: DEFAULT_PROJECT_SETTINGS,
} as unknown as RegisteredProject;

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(useProjects).mockReturnValue({
    data: [project],
    isLoading: false,
  } as unknown as ReturnType<typeof useProjects>);

  vi.mocked(useProjectIntegration).mockReturnValue({
    data: { plugin: null },
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectIntegration>);

  vi.mocked(useToast).mockReturnValue({
    addToast: vi.fn(),
    toasts: [],
    removeToast: vi.fn(),
  } as unknown as ReturnType<typeof useToast>);

  // Jig the project default points at currently exists in the list.
  vi.mocked(useJigs).mockReturnValue({
    data: [
      {
        id: SELECTED_JIG,
        name: "Responda Default",
        description: "",
        icon: "code",
        source: "project",
      },
    ],
    isLoading: false,
  } as unknown as ReturnType<typeof useJigs>);

  vi.mocked(useProjectDefaultJig).mockReturnValue({
    data: { jigId: SELECTED_JIG, source: "project" },
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectDefaultJig>);
  vi.mocked(useUpdateProjectDefaultJig).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useUpdateProjectDefaultJig>);

  vi.mocked(useProjectSettings).mockReturnValue({
    settings: DEFAULT_PROJECT_SETTINGS,
    isLoading: false,
    updateSettings: vi.fn(),
    updateSettingsAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
  } as unknown as ReturnType<typeof useProjectSettings>);

  vi.mocked(useIssueTypes).mockReturnValue({
    data: { configured: false, reason: "not-connected" },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useIssueTypes>);
  vi.mocked(useIssueTypeMappings).mockReturnValue({
    data: { mappings: {} },
  } as unknown as ReturnType<typeof useIssueTypeMappings>);
  vi.mocked(useUpdateIssueTypeMappings).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useUpdateIssueTypeMappings>);

  vi.mocked(useUpdateProjectBenchOverrides).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useUpdateProjectBenchOverrides>);
});

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/projects/:projectId/settings/*", element: <ProjectSettingsTab /> }],
    { initialEntries: [`/projects/${PROJECT_ID}/settings`] },
  );
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe("ProjectSettingsTab — clearing the project default jig", () => {
  it('does not crash when "Use app default" is clicked while a jig is selected', async () => {
    const user = userEvent.setup();
    renderTab();

    // Sanity: the picker rendered with the selected jig.
    expect(screen.getByRole("radio", { name: /responda default/i })).toBeChecked();

    await user.click(screen.getByText("Use app default"));

    // The form is now dirty -> the save bar surfaces, and nothing threw.
    expect(screen.getByRole("radio", { name: /use app default/i })).toBeChecked();
    expect(screen.getByTestId("settings-save-bar")).toBeInTheDocument();
  });

  it("does not crash when the configured default jig is missing from the jig list", async () => {
    // responda's .roubo/jigs/ is empty: the configured defaultJig id may not be
    // present in the available jigs. selectedId then points at a value with no
    // matching <Radio>.
    vi.mocked(useJigs).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useJigs>);

    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByText("Use app default"));

    expect(screen.getByRole("radio", { name: /use app default/i })).toBeChecked();
    expect(screen.getByTestId("settings-save-bar")).toBeInTheDocument();
  });

  it("does not crash on select-jig-then-clear when starting with no override", async () => {
    // Start with no project override (effective = app/global), like responda on disk.
    const noOverride = {
      ...project,
      config: { ...project.config, jigs: undefined },
    } as unknown as RegisteredProject;
    vi.mocked(useProjects).mockReturnValue({
      data: [noOverride],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    vi.mocked(useProjectDefaultJig).mockReturnValue({
      data: { jigId: "__global_default__", source: "global" },
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectDefaultJig>);

    const user = userEvent.setup();
    renderTab();

    // First pick a specific jig (form becomes dirty), then clear to app default.
    await user.click(screen.getByRole("radio", { name: /responda default/i }));
    expect(screen.getByRole("radio", { name: /responda default/i })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: /use app default/i }));

    expect(screen.getByRole("radio", { name: /use app default/i })).toBeChecked();
    expect(screen.getByTestId("settings-save-bar")).toBeInTheDocument();
  });

  it("does not crash when issue types are configured (GitHub Project linked)", async () => {
    vi.mocked(useIssueTypes).mockReturnValue({
      data: { configured: true, types: ["Bug", "Feature", "Task"] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useIssueTypes>);

    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByText("Use app default"));

    expect(screen.getByRole("radio", { name: /use app default/i })).toBeChecked();
    expect(screen.getByTestId("settings-save-bar")).toBeInTheDocument();
  });
});
