// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import EmbeddedGuidedSetup from "./EmbeddedGuidedSetup";
import type { RegisteredProject } from "@roubo/shared";

vi.mock("../hooks/useProjects");
vi.mock("../hooks/useSetup");

interface CapturedGuidedProps {
  isCreateMode: boolean;
  embedded: boolean;
  isSaving: boolean;
  saveError?: string;
  onSave: () => void;
}

// Capture SetupGuided props for introspection without rendering its full tree
let capturedSetupGuidedProps: Partial<CapturedGuidedProps> = {};
vi.mock("./setup/SetupGuided", () => ({
  default: (props: CapturedGuidedProps) => {
    capturedSetupGuidedProps = props;
    return (
      <div data-testid="setup-guided">
        <span data-testid="is-create-mode">{String(props.isCreateMode)}</span>
        <span data-testid="is-embedded">{String(props.embedded)}</span>
        <span data-testid="is-saving">{String(props.isSaving)}</span>
        {props.saveError && <span data-testid="save-error">{props.saveError}</span>}
        <button onClick={() => props.onSave()}>Save</button>
      </div>
    );
  },
}));

import { useRegisterProject } from "../hooks/useProjects";
import { useScanRepo, useValidateConfig, useSaveConfig, useEnvKeys } from "../hooks/useSetup";
import { ApiError } from "../lib/api";

const mockUseRegisterProject = vi.mocked(useRegisterProject);
const mockUseScanRepo = vi.mocked(useScanRepo);
const mockUseValidateConfig = vi.mocked(useValidateConfig);
const mockUseSaveConfig = vi.mocked(useSaveConfig);
const mockUseEnvKeys = vi.mocked(useEnvKeys);

function makeMutationMock(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    error: null,
    ...overrides,
  } as never;
}

function makeScan(
  overrides: {
    suggestedName?: string;
  } = {},
) {
  return {
    detected: {
      hasGit: true,
      submodules: {},
      structureType: "single-repo",
      dockerComposeFiles: [],
      dockerComposeServiceNames: {},
      dockerComposePortVars: {},
      dockerComposeVars: {},
      dotnetProjects: [],
      solutionFiles: [],
      viteProjects: [],
      envFiles: [],
      suggestedName: overrides.suggestedName ?? "test-repo",
      suggestedRepo: "acme/test-repo",
      suggestedComponents: [],
      suggestedTools: [],
    },
    existingConfig: null,
  };
}

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "test-project",
    repoPath: "/repos/test",
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

function renderComponent(onReady = vi.fn(), onSaved = vi.fn(), repoPath = "/repos/test") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EmbeddedGuidedSetup repoPath={repoPath} onReady={onReady} onSaved={onSaved} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  capturedSetupGuidedProps = {};
  mockUseScanRepo.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as never);
  mockUseValidateConfig.mockReturnValue(makeMutationMock());
  mockUseSaveConfig.mockReturnValue(makeMutationMock());
  mockUseRegisterProject.mockReturnValue(makeMutationMock());
  mockUseEnvKeys.mockReturnValue({ data: undefined } as never);
});

describe("EmbeddedGuidedSetup", () => {
  it("renders SetupGuided with isCreateMode and embedded props", () => {
    renderComponent();
    expect(capturedSetupGuidedProps.isCreateMode).toBe(true);
    expect(capturedSetupGuidedProps.embedded).toBe(true);
  });

  it("calls onReady on mount with a save function and initial disabled state", () => {
    const onReady = vi.fn();
    renderComponent(onReady);
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        save: expect.any(Function),
        isSaveDisabled: expect.any(Boolean),
        isSaving: false,
      }),
    );
  });

  it("handleSave calls saveConfig.mutate with repoPath and config", () => {
    const mutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate }) as never);
    const onReady = vi.fn();
    renderComponent(onReady);

    // Get the stable save function
    const { save } = onReady.mock.calls[0][0] as { save: () => void };
    act(() => {
      save();
    });

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: "/repos/test" }),
      expect.any(Object),
    );
  });

  it("calls registerProject.mutate on save success", () => {
    const saveMutate = vi.fn();
    const registerMutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }) as never);
    mockUseRegisterProject.mockReturnValue(makeMutationMock({ mutate: registerMutate }) as never);
    const onReady = vi.fn();
    renderComponent(onReady);

    const { save } = onReady.mock.calls[0][0] as { save: () => void };
    act(() => {
      save();
    });

    // Simulate save success
    const saveCallbacks = saveMutate.mock.calls[0][1] as {
      onSuccess: () => void;
    };
    act(() => {
      saveCallbacks.onSuccess();
    });

    expect(registerMutate).toHaveBeenCalledWith("/repos/test", expect.any(Object));
  });

  it("calls onSaved with project after register success", () => {
    const saveMutate = vi.fn();
    const registerMutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }) as never);
    mockUseRegisterProject.mockReturnValue(makeMutationMock({ mutate: registerMutate }) as never);
    const onReady = vi.fn();
    const onSaved = vi.fn();
    renderComponent(onReady, onSaved);

    const { save } = onReady.mock.calls[0][0] as { save: () => void };
    act(() => {
      save();
    });

    const saveCallbacks = saveMutate.mock.calls[0][1] as {
      onSuccess: () => void;
    };
    act(() => {
      saveCallbacks.onSuccess();
    });

    const registerCallbacks = registerMutate.mock.calls[0][1] as {
      onSuccess: (p: RegisteredProject) => void;
    };
    const project = makeProject();
    act(() => {
      registerCallbacks.onSuccess(project);
    });

    expect(onSaved).toHaveBeenCalledWith(project);
  });

  it("surfaces save error via onReady and does not call onSaved", () => {
    const saveMutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }) as never);
    const onReady = vi.fn();
    const onSaved = vi.fn();
    renderComponent(onReady, onSaved);

    const { save } = onReady.mock.calls[0][0] as { save: () => void };
    act(() => {
      save();
    });

    const saveCallbacks = saveMutate.mock.calls[0][1] as {
      onError: (err: Error) => void;
    };
    act(() => {
      saveCallbacks.onError(new Error("Schema validation failed"));
    });

    const allCalls = onReady.mock.calls;
    const lastCall = allCalls[allCalls.length - 1][0] as { saveError?: string };
    expect(lastCall.saveError).toBe("Schema validation failed");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("surfaces register-after-save error with combined message and does not call onSaved", () => {
    const saveMutate = vi.fn();
    const registerMutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }) as never);
    mockUseRegisterProject.mockReturnValue(makeMutationMock({ mutate: registerMutate }) as never);
    const onReady = vi.fn();
    const onSaved = vi.fn();
    renderComponent(onReady, onSaved);

    const { save } = onReady.mock.calls[0][0] as { save: () => void };
    act(() => {
      save();
    });

    const saveCallbacks = saveMutate.mock.calls[0][1] as {
      onSuccess: () => void;
    };
    act(() => {
      saveCallbacks.onSuccess();
    });

    const registerCallbacks = registerMutate.mock.calls[0][1] as {
      onError: (err: Error) => void;
    };
    act(() => {
      registerCallbacks.onError(new Error("Port conflict: 3000"));
    });

    const allCalls = onReady.mock.calls;
    const lastCall = allCalls[allCalls.length - 1][0] as { saveError?: string };
    expect(lastCall.saveError).toContain("Config saved, but registration failed");
    expect(lastCall.saveError).toContain("Port conflict: 3000");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("disables save when the scan supplies a name that fails validation", () => {
    mockUseScanRepo.mockReturnValue({
      data: makeScan({ suggestedName: "Invalid Name!" }),
      isLoading: false,
    } as never);
    const onReady = vi.fn();
    renderComponent(onReady);

    const allCalls = onReady.mock.calls;
    const lastCall = allCalls[allCalls.length - 1][0] as { isSaveDisabled: boolean };
    expect(lastCall.isSaveDisabled).toBe(true);
  });

  it("enables save once the scan supplies every required field", () => {
    mockUseScanRepo.mockReturnValue({
      data: makeScan(),
      isLoading: false,
    } as never);
    const onReady = vi.fn();
    renderComponent(onReady);

    const allCalls = onReady.mock.calls;
    const lastCall = allCalls[allCalls.length - 1][0] as { isSaveDisabled: boolean };
    expect(lastCall.isSaveDisabled).toBe(false);
  });

  it("maps server field errors into an actionable message instead of the generic one", () => {
    const saveMutate = vi.fn();
    mockUseSaveConfig.mockReturnValue(makeMutationMock({ mutate: saveMutate }) as never);
    const onReady = vi.fn();
    const onSaved = vi.fn();
    renderComponent(onReady, onSaved);

    const { save } = onReady.mock.calls[0][0] as { save: () => void };
    act(() => {
      save();
    });

    const saveCallbacks = saveMutate.mock.calls[0][1] as {
      onError: (err: Error) => void;
    };
    const apiErr = new ApiError(
      "Invalid config: project.displayName needs attention",
      400,
      undefined,
      {
        error: "Invalid config: project.displayName needs attention",
        errors: [{ path: "project.displayName", message: "Required" }],
        details: [],
      },
    );
    act(() => {
      saveCallbacks.onError(apiErr);
    });

    const allCalls = onReady.mock.calls;
    const lastCall = allCalls[allCalls.length - 1][0] as { saveError?: string };
    expect(lastCall.saveError).toBe("Please fix the highlighted fields above");
    expect(lastCall.saveError).not.toBe("Invalid config");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
