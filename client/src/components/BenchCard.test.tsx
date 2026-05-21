// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, DirtyReason } from "@roubo/shared";
import type {
  useStartBench,
  useStopBench,
  useTeardownBench,
  useCleanupAndRetryBench,
} from "../hooks/useBenches";
import type { useTeardownTracker } from "../hooks/useClearingTracker";
import { ApiError } from "../lib/api";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock("../hooks/useBenches");
vi.mock("../hooks/useClearingTracker");
vi.mock("../hooks/useToast");
vi.mock("./ToolButtons", () => ({ default: () => <div data-testid="tool-buttons" /> }));

import {
  useStartBench as _useStartBench,
  useStopBench as _useStopBench,
  useTeardownBench as _useTeardownBench,
  useCleanupAndRetryBench as _useCleanupAndRetryBench,
} from "../hooks/useBenches";
import { useTeardownTracker as _useTeardownTracker } from "../hooks/useClearingTracker";
import { useToast as _useToast } from "../hooks/useToast";
import BenchCard from "./BenchCard";

const mockedUseStartBench = vi.mocked(_useStartBench);
const mockedUseStopBench = vi.mocked(_useStopBench);
const mockedUseTeardownBench = vi.mocked(_useTeardownBench);
const mockedUseCleanupAndRetryBench = vi.mocked(_useCleanupAndRetryBench);
const mockedUseTeardownTracker = vi.mocked(_useTeardownTracker);
const mockedUseToast = vi.mocked(_useToast);

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

function makeDefaultMutations() {
  const startMutate = vi.fn();
  const stopMutate = vi.fn();
  // Default teardownMutate calls onSuccess synchronously so registerTeardown fires correctly
  const teardownMutate = vi.fn(
    (_vars: unknown, options?: { onSuccess?: () => void; onError?: (err: unknown) => void }) => {
      options?.onSuccess?.();
    },
  );
  const cleanupMutate = vi.fn();
  const registerTeardown = vi.fn();
  const addToast = vi.fn();

  mockedUseStartBench.mockReturnValue({
    mutate: startMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useStartBench>);
  mockedUseStopBench.mockReturnValue({
    mutate: stopMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useStopBench>);
  mockedUseTeardownBench.mockReturnValue({
    mutate: teardownMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useTeardownBench>);
  mockedUseCleanupAndRetryBench.mockReturnValue({
    mutate: cleanupMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useCleanupAndRetryBench>);
  mockedUseTeardownTracker.mockReturnValue({ register: registerTeardown } as unknown as ReturnType<
    typeof useTeardownTracker
  >);
  mockedUseToast.mockReturnValue({ addToast } as unknown as ReturnType<typeof _useToast>);

  return { startMutate, stopMutate, teardownMutate, cleanupMutate, registerTeardown, addToast };
}

function renderCard(bench: Bench, projectName?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <BenchCard bench={bench} projectName={projectName} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BenchCard", () => {
  describe("content rendering", () => {
    it("renders bench id and branch", () => {
      makeDefaultMutations();
      renderCard(makeBench({ id: 2, branch: "feat/new-login" }));
      expect(screen.getByText("Bench 2")).toBeInTheDocument();
      expect(screen.getByText("feat/new-login")).toBeInTheDocument();
    });

    it("renders project name when provided", () => {
      makeDefaultMutations();
      renderCard(makeBench(), "My Project");
      // CSS uppercase class does not change the DOM text content
      expect(screen.getByText("My Project")).toBeInTheDocument();
    });

    it("does not render project name when not provided", () => {
      makeDefaultMutations();
      renderCard(makeBench());
      expect(screen.queryByText("My Project")).toBeNull();
    });

    it("renders assigned issue number and title", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          assignedIssue: {
            number: 42,
            integrationId: "github-com",
            externalId: "42",
            title: "Fix the login bug",
          },
        }),
      );
      expect(screen.getByText("#42")).toBeInTheDocument();
      expect(screen.getByText("Fix the login bug")).toBeInTheDocument();
    });

    it("shows component names and matched ports when active", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "active",
          components: {
            api: { name: "api", status: "running", setupComplete: true },
            web: { name: "web", status: "running", setupComplete: true },
          },
          ports: { api: 3000, web: 3001 },
        }),
      );
      expect(screen.getByText("api")).toBeInTheDocument();
      expect(screen.getByText(":3000")).toBeInTheDocument();
      expect(screen.getByText("web")).toBeInTheDocument();
      expect(screen.getByText(":3001")).toBeInTheDocument();
    });

    it("shows orphan ports not matched to components", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          components: {},
          ports: { db: 5432 },
        }),
      );
      expect(screen.getByText("db")).toBeInTheDocument();
      expect(screen.getByText(":5432")).toBeInTheDocument();
    });
  });

  describe("provisioning steps", () => {
    it("shows provisioning steps when status is preparing", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "preparing",
          provisioningSteps: [
            { id: "step-1", label: "Cloning repo", status: "done" },
            { id: "step-2", label: "Installing deps", status: "running" },
          ],
        }),
      );
      expect(screen.getByText("Cloning repo")).toBeInTheDocument();
      expect(screen.getByText("Installing deps")).toBeInTheDocument();
    });

    it("shows teardown steps when status is clearing", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "clearing",
          teardownSteps: [{ id: "td-1", label: "Stopping containers", status: "running" }],
        }),
      );
      expect(screen.getByText("Stopping containers")).toBeInTheDocument();
    });

    it("shows provisioning steps on error status when steps exist", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "error",
          error: "Build failed",
          provisioningSteps: [{ id: "step-1", label: "Setting up workspace", status: "done" }],
        }),
      );
      expect(screen.getByText("Setting up workspace")).toBeInTheDocument();
    });

    it("hides components when provisioning steps are visible", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "preparing",
          components: { api: { name: "api", status: "running", setupComplete: true } },
          provisioningSteps: [{ id: "s1", label: "Building", status: "running" }],
        }),
      );
      expect(screen.queryByText("api")).toBeNull();
      expect(screen.getByText("Building")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    it("shows error message", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "error", error: "Build failed: command not found" }));
      expect(screen.getByText("Build failed: command not found")).toBeInTheDocument();
    });

    it("shows Cleanup & Retry button on error", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "error", error: "oops" }));
      expect(screen.getByText("Cleanup & Retry")).toBeInTheDocument();
    });

    it("calls cleanupAndRetry.mutate when Cleanup & Retry is pressed", async () => {
      const { cleanupMutate } = makeDefaultMutations();
      renderCard(makeBench({ id: 3, projectId: "proj-x", status: "error", error: "oops" }));
      await userEvent.click(screen.getByText("Cleanup & Retry"));
      expect(cleanupMutate).toHaveBeenCalledWith(
        { projectId: "proj-x", benchId: 3 },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    it("shows a toast when cleanup and retry fails", async () => {
      const { cleanupMutate, addToast } = makeDefaultMutations();
      // Capture the onError callback passed to mutate
      let capturedOnError: ((err: unknown) => void) | undefined;
      cleanupMutate.mockImplementation(
        (_vars: unknown, options?: { onError?: (err: unknown) => void }) => {
          capturedOnError = options?.onError;
        },
      );
      renderCard(makeBench({ id: 3, projectId: "proj-x", status: "error", error: "oops" }));
      await userEvent.click(screen.getByText("Cleanup & Retry"));
      capturedOnError?.(
        new Error("git worktree remove --force /workspace failed: fatal: not a worktree"),
      );
      expect(addToast).toHaveBeenCalledWith(
        "git worktree remove --force /workspace failed: fatal: not a worktree",
        expect.objectContaining({ duration: 8000 }),
      );
    });
  });

  describe("action buttons", () => {
    // The start/stop and teardown buttons are icon-only with no accessible name.
    // React Aria's TooltipTrigger adds aria-describedby (description), not aria-labelledby.
    // Button layout (no error state): [0]=start/stop, [1]=teardown.

    it("calls startBench.mutate when Play is pressed on idle bench", async () => {
      const { startMutate } = makeDefaultMutations();
      renderCard(makeBench({ id: 1, projectId: "proj-1", status: "idle" }));
      const [startStopButton] = screen.getAllByRole("button");
      await userEvent.click(startStopButton);
      expect(startMutate).toHaveBeenCalledWith({ projectId: "proj-1", benchId: 1 });
    });

    it("calls stopBench.mutate when Stop is pressed on active bench", async () => {
      const { stopMutate } = makeDefaultMutations();
      renderCard(makeBench({ id: 2, projectId: "proj-2", status: "active" }));
      const [stopButton] = screen.getAllByRole("button");
      await userEvent.click(stopButton);
      expect(stopMutate).toHaveBeenCalledWith({ projectId: "proj-2", benchId: 2 });
    });

    it("disables start/stop button when bench is preparing", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "preparing" }));
      const [startStopButton] = screen.getAllByRole("button");
      expect(startStopButton).toBeDisabled();
    });

    it("disables start/stop button when bench is clearing", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "clearing" }));
      const [startStopButton] = screen.getAllByRole("button");
      expect(startStopButton).toBeDisabled();
    });

    it("disables teardown button when bench is clearing", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "clearing" }));
      const buttons = screen.getAllByRole("button");
      const teardownButton = buttons[buttons.length - 1];
      expect(teardownButton).toBeDisabled();
    });

    it("renders Start with primary-CTA treatment on never-started idle bench", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "idle",
          components: {
            api: { name: "api", status: "stopped", setupComplete: false },
            web: { name: "web", status: "stopped", setupComplete: false },
          },
        }),
      );
      const [startButton] = screen.getAllByRole("button");
      expect(startButton.className).toContain("bg-amber-500");
    });

    it("renders Start with standard treatment on idle bench that was started before", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "idle",
          components: {
            api: { name: "api", status: "stopped", setupComplete: true },
            web: { name: "web", status: "stopped", setupComplete: false },
          },
        }),
      );
      const [startButton] = screen.getAllByRole("button");
      expect(startButton.className).not.toContain("bg-amber-500");
    });

    it("shows the idle hint on a never-started idle bench", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "idle",
          components: {
            api: { name: "api", status: "stopped", setupComplete: false },
            web: { name: "web", status: "stopped", setupComplete: false },
          },
        }),
      );
      expect(screen.getByText(/click Start to run components/i)).toBeInTheDocument();
    });

    it("hides the idle hint once any component has setupComplete", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "idle",
          components: {
            api: { name: "api", status: "stopped", setupComplete: true },
            web: { name: "web", status: "stopped", setupComplete: false },
          },
        }),
      );
      expect(screen.queryByText(/click Start to run components/i)).not.toBeInTheDocument();
    });

    it("hides the idle hint on an active bench", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          status: "active",
          components: {
            api: { name: "api", status: "running", setupComplete: false },
            web: { name: "web", status: "running", setupComplete: false },
          },
        }),
      );
      expect(screen.queryByText(/click Start to run components/i)).not.toBeInTheDocument();
    });
  });

  describe("navigation", () => {
    it("navigates to bench detail when card is clicked", async () => {
      makeDefaultMutations();
      renderCard(makeBench({ id: 7, projectId: "proj-nav" }));
      await userEvent.click(screen.getByRole("link"));
      expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-nav/benches/7");
    });
  });

  describe("cleanup pending state", () => {
    it('shows "Cleaning up..." and disables button when isPending', () => {
      const { cleanupMutate } = makeDefaultMutations();
      mockedUseCleanupAndRetryBench.mockReturnValue({
        mutate: cleanupMutate,
        isPending: true,
      } as unknown as ReturnType<typeof useCleanupAndRetryBench>);
      renderCard(makeBench({ status: "error", error: "oops" }));
      expect(screen.getByText("Cleaning up...")).toBeInTheDocument();
      expect(screen.getByText("Cleaning up...").closest("button")).toBeDisabled();
    });
  });

  describe("notification indicator", () => {
    it("shows notification indicator when bench has notifications", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          notifications: [
            {
              id: "n1",
              type: "claude-waiting",
              priority: "action-needed",
              createdAt: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      );
      expect(screen.getByRole("img", { name: "Action needed" })).toBeInTheDocument();
    });

    it("does not show notification indicator when bench has no notifications", () => {
      makeDefaultMutations();
      renderCard(makeBench({ notifications: [] }));
      expect(
        screen.queryByRole("img", { name: /action needed|notification/i }),
      ).not.toBeInTheDocument();
    });

    it("shows info notification indicator for non-action-needed notifications", () => {
      makeDefaultMutations();
      renderCard(
        makeBench({
          notifications: [
            { id: "n2", type: "bench-ready", priority: "info", createdAt: "2024-01-01T00:00:00Z" },
          ],
        }),
      );
      expect(screen.getByRole("img", { name: "Notification" })).toBeInTheDocument();
    });
  });

  describe("teardown confirmation dialog", () => {
    it("opens confirm dialog when teardown button is pressed", async () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]); // teardown is last
      expect(screen.getByText(/This will stop all components/)).toBeInTheDocument();
    });

    it("calls teardown.mutate and registerTeardown (via onSuccess) when confirm is pressed", async () => {
      const { teardownMutate, registerTeardown } = makeDefaultMutations();
      renderCard(makeBench({ id: 5, projectId: "proj-y", branch: "feat/old", status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]); // open dialog
      // Dialog confirm button has visible text "Clear bench"
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));
      expect(teardownMutate).toHaveBeenCalledWith(
        { projectId: "proj-y", benchId: 5 },
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      expect(registerTeardown).toHaveBeenCalledWith("proj-y", 5, "feat/old");
    });

    it("closes dialog without calling teardown when Cancel is pressed", async () => {
      const { teardownMutate } = makeDefaultMutations();
      renderCard(makeBench({ status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(teardownMutate).not.toHaveBeenCalled();
    });

    it("shows Cancel preparing wording in dialog for a preparing bench", async () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "preparing" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]); // teardown is enabled for preparing
      expect(screen.getByRole("heading", { name: "Cancel preparing" })).toBeInTheDocument();
    });
  });

  describe("dirty-bench confirmation", () => {
    const dirtyReasons: DirtyReason[] = [
      { kind: "dirty-worktree", location: "workspace", detail: "2 modified" },
      { kind: "unpushed-commits", location: "vendor/lib", detail: "1 commit ahead" },
    ];

    it("opens dirty-bench dialog when teardown returns 409 bench-dirty", async () => {
      const registerTeardown = vi.fn();
      const teardownMutate = vi.fn(
        (_vars: unknown, options?: { onError?: (err: unknown) => void }) => {
          options?.onError?.(new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }));
        },
      );
      mockedUseTeardownBench.mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useTeardownBench>);
      mockedUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
      } as unknown as ReturnType<typeof useTeardownTracker>);

      renderCard(makeBench({ id: 9, projectId: "proj-d", branch: "dirty-branch", status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]); // open initial confirm dialog
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));

      // Initial dialog should be closed, dirty dialog should open
      expect(
        screen.getByRole("dialog", { name: /uncommitted work detected/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("2 modified")).toBeInTheDocument();
      expect(screen.getByText("1 commit ahead")).toBeInTheDocument();
      // registerTeardown must NOT have been called yet
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
      mockedUseTeardownBench.mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useTeardownBench>);
      mockedUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
      } as unknown as ReturnType<typeof useTeardownTracker>);

      renderCard(makeBench({ id: 9, projectId: "proj-d", branch: "dirty-branch", status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));
      // Dirty dialog is open — confirm it
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));

      expect(teardownMutate).toHaveBeenCalledTimes(2);
      expect(teardownMutate).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectId: "proj-d", benchId: 9, force: true }),
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
      expect(registerTeardown).toHaveBeenCalledTimes(1);
      expect(registerTeardown).toHaveBeenCalledWith("proj-d", 9, "dirty-branch");
    });

    it("closes dirty dialog without retrying when Cancel is pressed", async () => {
      const registerTeardown = vi.fn();
      const teardownMutate = vi.fn(
        (_vars: unknown, options?: { onError?: (err: unknown) => void }) => {
          options?.onError?.(new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }));
        },
      );
      mockedUseTeardownBench.mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useTeardownBench>);
      mockedUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
      } as unknown as ReturnType<typeof useTeardownTracker>);

      renderCard(makeBench({ id: 9, projectId: "proj-d", branch: "dirty-branch", status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));
      // Dirty dialog opens — cancel it
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

      expect(
        screen.queryByRole("dialog", { name: /uncommitted work detected/i }),
      ).not.toBeInTheDocument();
      expect(teardownMutate).toHaveBeenCalledTimes(1); // only the initial attempt
      expect(registerTeardown).not.toHaveBeenCalled();
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
            // First teardown → dirty
            options?.onError?.(
              new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }),
            );
          } else if (callCount === 2) {
            // First force attempt → generic error sets forceError
            options?.onError?.(new ApiError("Server error", 500));
          } else {
            // Second force attempt → dirty again (server re-checked)
            options?.onError?.(
              new ApiError("dirty", 409, "bench-dirty", { reasons: dirtyReasons }),
            );
          }
        },
      );
      mockedUseTeardownBench.mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useTeardownBench>);
      mockedUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
      } as unknown as ReturnType<typeof useTeardownTracker>);

      renderCard(makeBench({ id: 9, projectId: "proj-d", branch: "dirty-branch", status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));
      // Dirty dialog opens → first force attempt → 500
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));
      expect(screen.getByText("Clear failed — please try again.")).toBeInTheDocument();
      // Second force attempt → fresh dirty 409 — stale error must disappear
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));
      expect(screen.queryByText("Clear failed — please try again.")).not.toBeInTheDocument();
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
      mockedUseTeardownBench.mockReturnValue({
        mutate: teardownMutate,
        isPending: false,
      } as unknown as ReturnType<typeof useTeardownBench>);
      mockedUseTeardownTracker.mockReturnValue({
        register: registerTeardown,
      } as unknown as ReturnType<typeof useTeardownTracker>);

      renderCard(makeBench({ id: 9, projectId: "proj-d", branch: "dirty-branch", status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));
      // Dirty dialog is open — confirm it
      await userEvent.click(screen.getByRole("button", { name: "Clear anyway" }));

      // Dialog must stay open and show an error — bench stays intact
      expect(
        screen.getByRole("dialog", { name: /uncommitted work detected/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("Clear failed — please try again.")).toBeInTheDocument();
      expect(registerTeardown).not.toHaveBeenCalled();
    });
  });
});
