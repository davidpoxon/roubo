// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Setup from "./Setup";

vi.mock("../../hooks/useProjects");
vi.mock("../../hooks/useSetup");
vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: () => ({ data: [], isLoading: false }),
}));
vi.mock("../../hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: null, isLoading: false }),
}));
// Mock SetupGuided so we don't re-test its internals here
vi.mock("./SetupGuided", () => ({
  default: ({
    isCreateMode,
    onSave,
    isSaving,
    saveError,
    validationStatus,
    onValidate,
    onModeChange,
  }: {
    isCreateMode: boolean;
    onSave: () => void;
    isSaving: boolean;
    saveError?: string;
    validationStatus?: string;
    onValidate?: () => void;
    onModeChange?: (mode: string) => void;
  }) => (
    <div data-testid="setup-guided">
      <span data-testid="create-mode">{String(isCreateMode)}</span>
      <span data-testid="is-saving">{String(isSaving)}</span>
      <span data-testid="validation-status">{validationStatus ?? "idle"}</span>
      {saveError && <span data-testid="save-error">{saveError}</span>}
      <button onClick={onSave}>Save</button>
      <button onClick={onValidate}>Validate</button>
      <button onClick={() => onModeChange?.("yaml")}>Switch Mode</button>
    </div>
  ),
}));

import { useProjects, useRegisterProject, useReloadProjectConfig } from "../../hooks/useProjects";
import {
  useScanRepo,
  useValidateConfig,
  useSaveConfig,
  useEnvKeys,
  useRawConfig,
  useSaveRawConfig,
} from "../../hooks/useSetup";

const mockUseProjects = vi.mocked(useProjects);
const mockUseRegisterProject = vi.mocked(useRegisterProject);
const mockUseReloadProjectConfig = vi.mocked(useReloadProjectConfig);
const mockUseScanRepo = vi.mocked(useScanRepo);
const mockUseValidateConfig = vi.mocked(useValidateConfig);
const mockUseSaveConfig = vi.mocked(useSaveConfig);
const mockUseEnvKeys = vi.mocked(useEnvKeys);
const mockUseRawConfig = vi.mocked(useRawConfig);
const mockUseSaveRawConfig = vi.mocked(useSaveRawConfig);

function makeMutationMock(overrides = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    error: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseProjects.mockReturnValue({ data: [] } as never);
  mockUseRegisterProject.mockReturnValue(makeMutationMock());
  mockUseReloadProjectConfig.mockReturnValue(makeMutationMock());
  mockUseScanRepo.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as never);
  mockUseValidateConfig.mockReturnValue(makeMutationMock());
  mockUseSaveConfig.mockReturnValue(makeMutationMock());
  mockUseEnvKeys.mockReturnValue({ data: undefined } as never);
  mockUseRawConfig.mockReturnValue({ data: undefined } as never);
  mockUseSaveRawConfig.mockReturnValue(makeMutationMock());
});

function renderSetup(path = "/setup") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/projects/:projectId/settings/setup" element={<Setup />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Setup", () => {
  it("renders SetupGuided", () => {
    renderSetup();
    expect(screen.getByTestId("setup-guided")).toBeInTheDocument();
  });

  it("passes isCreateMode=true when no projectId", () => {
    renderSetup();
    expect(screen.getByTestId("create-mode")).toHaveTextContent("true");
  });

  it("passes isCreateMode=false in edit mode", () => {
    const editProject = {
      id: "proj-1",
      repoPath: "/repo",
      configValid: true,
      config: {
        project: {
          name: "my-app",
          displayName: "My App",
          repo: "org/r",
        },
        layout: { type: "single-repo" },
        ports: {},
        components: {},
        benches: { max: 1 },
      },
    };
    mockUseProjects.mockReturnValue({ data: [editProject] } as never);
    renderSetup("/projects/proj-1/settings/setup");
    expect(screen.getByTestId("create-mode")).toHaveTextContent("false");
  });

  it("passes isSaving=true while mutation is pending", () => {
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ isPending: true }));
    renderSetup();
    expect(screen.getByTestId("is-saving")).toHaveTextContent("true");
  });

  it("calls saveConfig.mutate when save button is clicked", async () => {
    const mutateFn = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: mutateFn }));
    renderSetup();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(mutateFn).toHaveBeenCalled();
  });

  it("calls registerProject.mutate on successful save in create mode", async () => {
    const saveMutate = vi.fn((_args: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    const registerMutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }));
    mockUseRegisterProject.mockReturnValue(makeMutationMock({ mutate: registerMutate }));
    renderSetup();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(registerMutate).toHaveBeenCalled();
  });

  it("preserves validationStatus and errors after switching modes", async () => {
    type MutateOpts = {
      onSuccess?: (r: {
        valid: boolean;
        errors: { path: string; message: string }[];
        portConflicts: [];
      }) => void;
    };
    const validationResult = {
      valid: false,
      errors: [{ path: "project", message: "Required" }],
      portConflicts: [] as [],
    };
    const mutateFn = vi.fn((_args: unknown, opts?: MutateOpts) => {
      opts?.onSuccess?.(validationResult);
    });
    mockUseValidateConfig.mockReturnValue(makeMutationMock({ mutate: mutateFn }));
    renderSetup();

    await userEvent.click(screen.getByRole("button", { name: /validate/i }));
    expect(screen.getByTestId("validation-status")).toHaveTextContent("errors");

    await userEvent.click(screen.getByRole("button", { name: /switch mode/i }));
    expect(screen.getByTestId("validation-status")).toHaveTextContent("errors");
  });

  it("does NOT call registerProject.mutate in edit mode after save", async () => {
    const saveMutate = vi.fn((_args: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    });
    const registerMutate = vi.fn();
    const editProject = {
      id: "proj-1",
      repoPath: "/repo",
      configValid: true,
      config: {
        project: {
          name: "my-app",
          displayName: "My App",
          repo: "org/r",
        },
        layout: { type: "single-repo" },
        ports: {},
        components: {},
        benches: { max: 1 },
      },
    };
    mockUseProjects.mockReturnValue({ data: [editProject] } as never);
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }));
    mockUseRegisterProject.mockReturnValue(makeMutationMock({ mutate: registerMutate }));
    renderSetup("/projects/proj-1/settings/setup");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(registerMutate).not.toHaveBeenCalled();
  });
});
