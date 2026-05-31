// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bench, RegisteredProject } from "@roubo/shared";
import DangerZoneTile from "./DangerZoneTile";

const mockNavigate = vi.fn();
const mockAddToast = vi.fn();
const mockMutate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../hooks/useProjects", () => ({
  useProjects: vi.fn(),
  useUnregisterProject: vi.fn(),
}));

vi.mock("../../hooks/useToast", () => ({
  useToast: vi.fn(),
}));

vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: vi.fn(),
}));

import { useProjects, useUnregisterProject } from "../../hooks/useProjects";
import { useToast } from "../../hooks/useToast";
import { useProjectBenches } from "../../hooks/useBenches";

function makeProject(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
  return {
    id: "proj-1",
    repoPath: "/repos/my-app",
    configValid: true,
    config: {
      project: {
        name: "my-app",
        displayName: "My App",
        repo: "org/my-app",
      },
      layout: { type: "single-repo" },
      components: {},
      ports: {},
      benches: { max: 3 },
    },
    settings: {
      worktreeSource: { branchFromDefault: true, pullLatest: true },
    },
    ...overrides,
  };
}

function makeBench(overrides: Partial<Bench> = {}): Bench {
  return {
    id: 1,
    projectId: "proj-1",
    branch: "main",
    workspacePath: "/workspace/bench-1",
    status: "idle",
    ports: {},
    components: {},
    createdAt: "2024-01-01T00:00:00Z",
    provisioningSteps: [],
    teardownSteps: [],
    notifications: [],
    ...overrides,
  };
}

function setupMocks({
  isPending = false,
  mutateFn = mockMutate,
  benches = [] as Bench[],
}: {
  isPending?: boolean;
  mutateFn?: typeof mockMutate;
  benches?: Bench[];
} = {}) {
  vi.mocked(useProjects).mockReturnValue({
    data: [makeProject()],
    isLoading: false,
  } as unknown as ReturnType<typeof useProjects>);

  vi.mocked(useUnregisterProject).mockReturnValue({
    mutate: mutateFn,
    isPending,
  } as unknown as ReturnType<typeof useUnregisterProject>);

  vi.mocked(useToast).mockReturnValue({
    addToast: mockAddToast,
    removeToast: vi.fn(),
  });

  vi.mocked(useProjectBenches).mockReturnValue({
    data: benches,
    isLoading: false,
  } as unknown as ReturnType<typeof useProjectBenches>);
}

beforeEach(() => {
  mockNavigate.mockReset();
  mockAddToast.mockReset();
  mockMutate.mockReset();
});

describe("DangerZoneTile", () => {
  it("renders the section heading, title, and description", () => {
    setupMocks();
    render(<DangerZoneTile projectId="proj-1" />);
    expect(screen.getByRole("region", { name: "Unregister project" })).toBeInTheDocument();
    expect(screen.getByText("Unregister project")).toBeInTheDocument();
    expect(screen.getByText(/Does not touch the repository/)).toBeInTheDocument();
  });

  it("renders the Unregister button", () => {
    setupMocks();
    render(<DangerZoneTile projectId="proj-1" />);
    expect(screen.getByRole("button", { name: "Unregister" })).toBeInTheDocument();
  });

  it("renders nothing when project is not found", () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    vi.mocked(useUnregisterProject).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUnregisterProject>);
    vi.mocked(useToast).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
    });
    vi.mocked(useProjectBenches).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectBenches>);
    const { container } = render(<DangerZoneTile projectId="unknown" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the confirmation dialog when Unregister is clicked", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Unregister My App?")).toBeInTheDocument();
  });

  it("does not call mutate when Cancel is clicked in the dialog", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it("calls mutate with the correct projectId when dialog Unregister is confirmed", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockMutate).toHaveBeenCalledWith(
      { projectId: "proj-1", force: false },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("navigates to / and adds a success toast on onSuccess", async () => {
    const mutateFn = vi.fn(
      (
        _input: { projectId: string; force?: boolean },
        options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
      ) => {
        options?.onSuccess?.();
      },
    );
    setupMocks({ mutateFn });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
    expect(mockAddToast).toHaveBeenCalledWith("Unregistered My App.");
  });

  it("adds an error toast with the error message on onError", async () => {
    const testError = new Error("Server unreachable");
    const mutateFn = vi.fn(
      (
        _input: { projectId: string; force?: boolean },
        options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
      ) => {
        options?.onError?.(testError);
      },
    );
    setupMocks({ mutateFn });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockAddToast).toHaveBeenCalledWith("Server unreachable", {
      duration: 8000,
    });
  });

  it("adds a generic error toast when the error has no message", async () => {
    const mutateFn = vi.fn(
      (
        _input: { projectId: string; force?: boolean },
        options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
      ) => {
        options?.onError?.({});
      },
    );
    setupMocks({ mutateFn });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockAddToast).toHaveBeenCalledWith("Failed to unregister project.", {
      duration: 8000,
    });
  });

  it("adds a generic error toast when the error message is an empty string", async () => {
    const mutateFn = vi.fn(
      (
        _input: { projectId: string; force?: boolean },
        options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
      ) => {
        options?.onError?.(new Error(""));
      },
    );
    setupMocks({ mutateFn });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockAddToast).toHaveBeenCalledWith("Failed to unregister project.", {
      duration: 8000,
    });
  });

  it("disables dialog buttons and shows Unregistering… while isPending", async () => {
    setupMocks({ isPending: true });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByRole("button", { name: "Unregistering…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("uses repoPath as display name when config is absent", async () => {
    vi.mocked(useProjects).mockReturnValue({
      data: [
        makeProject({
          config: undefined,
          configValid: false,
          repoPath: "/home/user/my-project",
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    vi.mocked(useUnregisterProject).mockReturnValue({
      mutate: vi.fn(
        (
          _id: string,
          options?: {
            onSuccess?: () => void;
            onError?: (err: unknown) => void;
          },
        ) => {
          options?.onSuccess?.();
        },
      ),
      isPending: false,
    } as unknown as ReturnType<typeof useUnregisterProject>);
    vi.mocked(useToast).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
    });
    vi.mocked(useProjectBenches).mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectBenches>);
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByText("Unregister /home/user/my-project?")).toBeInTheDocument();
    await user.type(
      within(screen.getByRole("dialog")).getByRole("textbox"),
      "/home/user/my-project",
    );
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockAddToast).toHaveBeenCalledWith("Unregistered /home/user/my-project.");
  });

  // --- "not touched" list ---

  it("shows the not-touched list in the dialog", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/will not be touched/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Repository at/)).toBeInTheDocument();
    expect(within(dialog).getByText("Branches")).toBeInTheDocument();
    expect(within(dialog).getByText("Existing worktrees (benches)")).toBeInTheDocument();
    expect(within(dialog).getByText("Git state")).toBeInTheDocument();
  });

  // --- active-benches warning ---

  it("shows no bench warning when there are no benches", async () => {
    setupMocks({ benches: [] });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.queryByText(/will stop being monitored/)).not.toBeInTheDocument();
  });

  it("shows singular bench warning when there is one bench", async () => {
    setupMocks({ benches: [makeBench()] });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByText(/1 registered bench will stop being monitored/)).toBeInTheDocument();
  });

  it("shows plural bench warning when there are multiple benches", async () => {
    setupMocks({
      benches: [makeBench({ id: 1 }), makeBench({ id: 2 })],
    });
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByText(/2 registered benches will stop being monitored/)).toBeInTheDocument();
  });

  // --- typing guard ---

  it("Confirm button is disabled initially when dialog opens", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    ).toBeDisabled();
  });

  it("Confirm button enables after typing the exact project name", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    ).not.toBeDisabled();
  });

  it("Confirm button stays disabled for a wrong-case name", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "my app");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    ).toBeDisabled();
  });

  it("Confirm button stays disabled for a partial name", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My Ap");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    ).toBeDisabled();
  });

  it("does not call mutate when Confirm is clicked with a wrong name", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "wrong name");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    );
    expect(mockMutate).not.toHaveBeenCalled();
  });

  // --- force-unregister (project folder missing) ---

  function setupErroredProject(benches: Bench[]) {
    vi.mocked(useProjects).mockReturnValue({
      data: [
        makeProject({
          config: undefined,
          configValid: false,
          repoPath: "/repos/gone",
        }),
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useProjects>);
    vi.mocked(useUnregisterProject).mockReturnValue({
      mutate: mockMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUnregisterProject>);
    vi.mocked(useToast).mockReturnValue({
      addToast: mockAddToast,
      removeToast: vi.fn(),
    });
    vi.mocked(useProjectBenches).mockReturnValue({
      data: benches,
      isLoading: false,
    } as unknown as ReturnType<typeof useProjectBenches>);
  }

  it("renders the force note and Force unregister button for an errored project with benches", async () => {
    setupErroredProject([makeBench()]);
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.getByTestId("force-unregister-note")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Force unregister" }),
    ).toBeInTheDocument();
    // The non-force "will stop being monitored" warning should not show
    expect(screen.queryByText(/will stop being monitored/)).not.toBeInTheDocument();
  });

  it("calls mutate with force=true when confirming an errored project with benches", async () => {
    setupErroredProject([makeBench(), makeBench({ id: 2 })]);
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "/repos/gone");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Force unregister" }),
    );
    expect(mockMutate).toHaveBeenCalledWith(
      { projectId: "proj-1", force: true },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
  });

  it("does not show the force note for an errored project with no benches", async () => {
    setupErroredProject([]);
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(screen.queryByTestId("force-unregister-note")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Unregister" }),
    ).toBeInTheDocument();
  });

  it("resets the typed name after the dialog closes via Cancel", async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<DangerZoneTile projectId="proj-1" />);

    // Open, type, cancel
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    await user.type(within(screen.getByRole("dialog")).getByRole("textbox"), "My App");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Reopen — input should be empty, Confirm disabled
    await user.click(screen.getByRole("button", { name: "Unregister" }));
    expect(within(screen.getByRole("dialog")).getByRole("textbox")).toHaveValue("");
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Unregister",
      }),
    ).toBeDisabled();
  });
});
