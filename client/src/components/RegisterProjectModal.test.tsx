// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import RegisterProjectModal from "./RegisterProjectModal";
import type { RegisteredProject, CheckConfigResult } from "@roubo/shared";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../hooks/useProjects", () => ({
  useCheckConfig: vi.fn(),
  useRegisterProject: vi.fn(),
}));

vi.mock("./DirectoryPicker", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input
      data-testid="directory-picker"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

let capturedSetupOnReady: ((h: Record<string, unknown>) => void) | null = null;
vi.mock("./EmbeddedGuidedSetup", () => ({
  default: ({
    onReady,
  }: {
    onReady: (h: Record<string, unknown>) => void;
    repoPath: string;
    onSaved: (p: RegisteredProject) => void;
  }) => {
    capturedSetupOnReady = onReady;
    return <div data-testid="embedded-guided-setup" />;
  },
}));

import { useCheckConfig, useRegisterProject } from "../hooks/useProjects";

const mockedUseCheckConfig = vi.mocked(useCheckConfig);
const mockedUseRegisterProject = vi.mocked(useRegisterProject);

const noopMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null,
  reset: vi.fn(),
};

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "my-app",
    repoPath: "/repos/my-app",
    configValid: true,
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
    ...overrides,
  };
}

function renderModal(isOpen = true, onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RegisterProjectModal isOpen={isOpen} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockNavigate.mockReset();
  capturedSetupOnReady = null;
  mockedUseCheckConfig.mockReturnValue({
    data: undefined,
    isLoading: false,
    isFetching: false,
  } as unknown as ReturnType<typeof useCheckConfig>);
  mockedUseRegisterProject.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useRegisterProject>,
  );
});

describe("RegisterProjectModal", () => {
  it("renders the modal with title when open", () => {
    renderModal(true);
    expect(screen.getByRole("heading", { name: "Register project" })).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderModal(false);
    expect(screen.queryByText("Register project")).not.toBeInTheDocument();
  });

  it("shows checking state when path entered and query is loading", async () => {
    mockedUseCheckConfig.mockReturnValue({
      data: undefined,
      isLoading: true,
      isFetching: true,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("directory-picker"), "/some/path");
    expect(screen.getByText("Checking for configuration...")).toBeInTheDocument();
  });

  it("shows preview when valid yaml found", () => {
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: false,
      projectName: "my-app",
      displayName: "My App",
      preview: {
        name: "my-app",
        displayName: "My App",
        ports: [
          { name: "server", base: 5300 },
          { name: "client", base: 5301 },
        ],
        benchCap: 3,
      },
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "SPAN" &&
          (el.textContent?.replace(/\s+/g, " ").trim() ?? "") === "Found .roubo/roubo.yaml",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("My App")).toBeInTheDocument();
    expect(screen.getByText("Port · server")).toBeInTheDocument();
    expect(screen.getByText("5300")).toBeInTheDocument();
    expect(screen.getByText("Port · client")).toBeInTheDocument();
    expect(screen.getByText("5301")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("enables register button only when config is valid and not already registered", () => {
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: false,
      projectName: "my-app",
      displayName: "My App",
      preview: {
        name: "my-app",
        displayName: "My App",
        ports: [],
        benchCap: 3,
      },
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(screen.getByRole("button", { name: /register my app/i })).not.toBeDisabled();
  });

  it("disables register button when no path entered", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /register project/i })).toBeDisabled();
  });

  it("disables register button when already registered", () => {
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: true,
      projectName: "my-app",
      project: makeProject(),
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(screen.getByRole("button", { name: /register project/i })).toBeDisabled();
  });

  it("shows already-registered state with Go to project button", () => {
    const project = makeProject();
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: true,
      displayName: "My App",
      projectName: "my-app",
      project,
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(screen.getByText(/already registered/)).toBeInTheDocument();
    expect(screen.getByText(/go to project/i)).toBeInTheDocument();
  });

  it("navigates to project page when Go to project is clicked", async () => {
    const project = makeProject({ id: "my-app" });
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: true,
      displayName: "My App",
      project,
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    const onClose = vi.fn();
    renderModal(true, onClose);
    const user = userEvent.setup();
    await user.click(screen.getByText(/go to project/i));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/my-app");
  });

  it("shows no-yaml state when hasConfig is false and no error", () => {
    const check: CheckConfigResult = {
      hasConfig: false,
      configValid: false,
      alreadyRegistered: false,
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === "P" &&
          /no .roubo\/roubo.yaml found/i.test(el.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create configuration/i })).toBeInTheDocument();
  });

  it("shows invalid yaml error and Edit config link when project is registered", () => {
    const project = makeProject({ id: "my-app", configValid: false });
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: false,
      alreadyRegistered: true,
      project,
      error: "Missing required field: project.name",
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(screen.getByText("Missing required field: project.name")).toBeInTheDocument();
    expect(screen.getByText(/edit config/i)).toBeInTheDocument();
  });

  it("does not show Edit config button when invalid yaml and project is not registered", () => {
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: false,
      alreadyRegistered: false,
      error: "Missing required field: project.name",
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(screen.getByText("Missing required field: project.name")).toBeInTheDocument();
    expect(screen.queryByText(/edit config/i)).not.toBeInTheDocument();
  });

  it("navigates to /projects/:id/settings/setup when Edit config clicked and project is registered", async () => {
    const onClose = vi.fn();
    const project = makeProject({ id: "my-app", configValid: false });
    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: false,
      alreadyRegistered: true,
      project,
      error: "Missing required field: project.name",
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal(true, onClose);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("directory-picker"), "/home/user/repo");
    await user.click(screen.getByText(/edit config/i));
    expect(mockNavigate).toHaveBeenCalledWith("/projects/my-app/settings/setup");
  });

  it("shows directory not found error", () => {
    const check: CheckConfigResult = {
      hasConfig: false,
      configValid: false,
      alreadyRegistered: false,
      error: "Directory not found",
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    expect(screen.getByText("Directory not found")).toBeInTheDocument();
  });

  it("calls registerProject.mutate when register button is pressed", async () => {
    const mutate = vi.fn();
    mockedUseRegisterProject.mockReturnValue({
      ...noopMutation,
      mutate,
    } as unknown as ReturnType<typeof useRegisterProject>);

    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: false,
      preview: {
        name: "my-app",
        displayName: "My App",
        ports: [],
        benchCap: 3,
      },
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("directory-picker"), "/home/user/repo");
    await user.click(screen.getByRole("button", { name: /register my app/i }));
    expect(mutate).toHaveBeenCalledWith("/home/user/repo", expect.any(Object));
  });

  it("navigates to project page on successful registration", async () => {
    let capturedCallbacks: { onSuccess?: (p: RegisteredProject) => void } = {};
    mockedUseRegisterProject.mockReturnValue({
      ...noopMutation,
      mutate: vi.fn((_path, callbacks) => {
        capturedCallbacks = callbacks ?? {};
      }),
    } as unknown as ReturnType<typeof useRegisterProject>);

    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: false,
      preview: {
        name: "my-app",
        displayName: "My App",
        ports: [],
        benchCap: 3,
      },
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    const onClose = vi.fn();
    renderModal(true, onClose);
    const user = userEvent.setup();
    await user.type(screen.getByTestId("directory-picker"), "/home/user/repo");
    await user.click(screen.getByRole("button", { name: /register my app/i }));

    act(() => {
      capturedCallbacks.onSuccess?.(makeProject({ id: "my-app" }));
    });

    expect(onClose).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/projects/my-app");
  });

  it("shows registration error when mutate fails", async () => {
    let capturedCallbacks: { onError?: (err: Error) => void } = {};
    mockedUseRegisterProject.mockReturnValue({
      ...noopMutation,
      mutate: vi.fn((_path, callbacks) => {
        capturedCallbacks = callbacks ?? {};
      }),
    } as unknown as ReturnType<typeof useRegisterProject>);

    const check: CheckConfigResult = {
      hasConfig: true,
      configValid: true,
      alreadyRegistered: false,
      preview: {
        name: "my-app",
        displayName: "My App",
        ports: [],
        benchCap: 3,
      },
    };
    mockedUseCheckConfig.mockReturnValue({
      data: check,
      isLoading: false,
      isFetching: false,
    } as unknown as ReturnType<typeof useCheckConfig>);

    renderModal();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("directory-picker"), "/home/user/repo");
    await user.click(screen.getByRole("button", { name: /register my app/i }));

    act(() => {
      capturedCallbacks.onError?.(new Error("Port conflict"));
    });

    await screen.findByText("Port conflict");
  });

  describe("missing-yaml → embedded Setup flow", () => {
    const noYamlCheck: CheckConfigResult = {
      hasConfig: false,
      configValid: false,
      alreadyRegistered: false,
    };

    beforeEach(() => {
      mockedUseCheckConfig.mockReturnValue({
        data: noYamlCheck,
        isLoading: false,
        isFetching: false,
      } as unknown as ReturnType<typeof useCheckConfig>);
    });

    it("clicking Create configuration transitions to setup step", async () => {
      renderModal();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      expect(screen.getByRole("heading", { name: "Set up project" })).toBeInTheDocument();
      expect(screen.getByTestId("embedded-guided-setup")).toBeInTheDocument();
    });

    it("cancel from setup step returns to path-entry with heading restored", async () => {
      renderModal();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      expect(screen.getByRole("heading", { name: "Set up project" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /^cancel$/i }));
      expect(screen.getByRole("heading", { name: "Register project" })).toBeInTheDocument();
      expect(screen.queryByTestId("embedded-guided-setup")).not.toBeInTheDocument();
    });

    it("cancel in setup step does not call onClose", async () => {
      const onClose = vi.fn();
      renderModal(true, onClose);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      await user.click(screen.getByRole("button", { name: /^cancel$/i }));
      expect(onClose).not.toHaveBeenCalled();
    });

    it("X button closes from setup step", async () => {
      const onClose = vi.fn();
      renderModal(true, onClose);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      await user.click(screen.getByRole("button", { name: /close/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it("Save & register is disabled before EmbeddedGuidedSetup calls onReady", async () => {
      renderModal();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      expect(screen.getByRole("button", { name: /save & register/i })).toBeDisabled();
    });

    it("Save & register calls setup save handler when enabled", async () => {
      const mockSave = vi.fn();
      renderModal();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      act(() => {
        expect(capturedSetupOnReady).not.toBeNull();
        capturedSetupOnReady?.({
          save: mockSave,
          isSaveDisabled: false,
          isSaving: false,
        });
      });
      await user.click(screen.getByRole("button", { name: /save & register/i }));
      expect(mockSave).toHaveBeenCalledTimes(1);
    });

    it("Cancel is disabled while saving", async () => {
      renderModal();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      act(() => {
        expect(capturedSetupOnReady).not.toBeNull();
        capturedSetupOnReady?.({
          save: vi.fn(),
          isSaveDisabled: false,
          isSaving: true,
        });
      });
      expect(screen.getByRole("button", { name: /^cancel$/i })).toBeDisabled();
    });

    it("X button is disabled while saving", async () => {
      renderModal();
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /create configuration/i }));
      act(() => {
        expect(capturedSetupOnReady).not.toBeNull();
        capturedSetupOnReady?.({
          save: vi.fn(),
          isSaveDisabled: false,
          isSaving: true,
        });
      });
      expect(screen.getByRole("button", { name: /close/i })).toBeDisabled();
    });
  });
});
