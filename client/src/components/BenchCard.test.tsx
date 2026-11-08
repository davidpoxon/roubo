// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, DirtyReason } from "@roubo/shared";
import type {
  useStartBench,
  useStopBench,
  useTeardownBench,
  useCleanupAndRetryBench,
  useRestartBenchWithConfig,
} from "../hooks/useBenches";
import type { useTeardownTracker } from "../hooks/useClearingTracker";
import { ApiError } from "../lib/api";
import * as api from "../lib/api";
import type { DeliveryRecord } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord } from "../test/delivery-fixtures";

const mockNavigate = vi.fn();
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});
// A Spec Bench card reads its delivery (#1624). The read stays pending unless a
// test answers it.
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, fetchDelivery: vi.fn(() => new Promise(() => undefined)) };
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
  useRestartBenchWithConfig as _useRestartBenchWithConfig,
} from "../hooks/useBenches";
import { useTeardownTracker as _useTeardownTracker } from "../hooks/useClearingTracker";
import { useToast as _useToast } from "../hooks/useToast";
import BenchCard from "./BenchCard";

const mockedUseStartBench = vi.mocked(_useStartBench);
const mockedUseStopBench = vi.mocked(_useStopBench);
const mockedUseTeardownBench = vi.mocked(_useTeardownBench);
const mockedUseCleanupAndRetryBench = vi.mocked(_useCleanupAndRetryBench);
const mockedUseRestartBenchWithConfig = vi.mocked(_useRestartBenchWithConfig);
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
  const restartMutate = vi.fn();
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
  mockedUseRestartBenchWithConfig.mockReturnValue({
    mutate: restartMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useRestartBenchWithConfig>);
  mockedUseTeardownTracker.mockReturnValue({ register: registerTeardown } as unknown as ReturnType<
    typeof useTeardownTracker
  >);
  mockedUseToast.mockReturnValue({ addToast } as unknown as ReturnType<typeof _useToast>);

  return {
    startMutate,
    stopMutate,
    teardownMutate,
    cleanupMutate,
    restartMutate,
    registerTeardown,
    addToast,
  };
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
  describe("stale bench marker and Restart with new config", () => {
    it("HR-TC-007: a stale bench shows the marker beside its status label, with its tooltip", async () => {
      const user = userEvent.setup();
      makeDefaultMutations();
      renderCard(makeBench({ stale: true }));
      const marker = screen.getByTestId("bench-card-stale-marker");
      expect(marker).toHaveTextContent("stale · Set up with an older roubo.yaml");
      // Beside the status label: both sit in the same group of the card head.
      expect(marker.parentElement).toBe(screen.getByTestId("bench-card-status").parentElement);
      // The card itself takes the first Tab, the marker the next.
      await user.tab();
      await user.tab();
      expect(marker).toHaveFocus();
      expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "This bench keeps the component definitions it was set up with. Restart with new config to apply the current roubo.yaml.",
      );
    });

    it("HR-TC-007: Restart with new config calls the restart action for the bench", async () => {
      const user = userEvent.setup();
      const { restartMutate } = makeDefaultMutations();
      renderCard(makeBench({ id: 4, projectId: "lantern", stale: true }));
      await user.click(screen.getByRole("button", { name: /Restart with new config/ }));
      expect(restartMutate).toHaveBeenCalledWith(
        { projectId: "lantern", benchId: 4 },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it("HR-TC-007: a bench that is not stale shows no marker and no restart action", () => {
      makeDefaultMutations();
      renderCard(makeBench({ stale: false }));
      expect(screen.queryByTestId("bench-card-stale-marker")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Restart with new config/ }),
      ).not.toBeInTheDocument();
    });

    it("HR-TC-006: a legacy bench, which reports no stale flag, shows no marker and no restart action", () => {
      makeDefaultMutations();
      renderCard(makeBench());
      expect(screen.queryByTestId("bench-card-stale-marker")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Restart with new config/ }),
      ).not.toBeInTheDocument();
    });

    it("disables Restart with new config while the bench is preparing", () => {
      makeDefaultMutations();
      renderCard(makeBench({ stale: true, status: "preparing" }));
      expect(screen.getByRole("button", { name: /Restart with new config/ })).toBeDisabled();
    });
  });

  describe("content rendering", () => {
    it("renders bench id and branch", () => {
      makeDefaultMutations();
      renderCard(makeBench({ id: 2, branch: "feat/new-login" }));
      expect(screen.getByText("Bench 2")).toBeInTheDocument();
      expect(screen.getByText("feat/new-login")).toBeInTheDocument();
    });

    it("SB-TC-001: shows the Spec Bench variant badge in the card head", () => {
      makeDefaultMutations();
      renderCard(makeBench({ variant: "specbench", deliveryBindMode: "launch" }));
      const badge = screen.getByTestId("bench-variant-badge");
      expect(badge).toHaveTextContent("Spec Bench");
      expect(badge.className).toContain("bg-accent-muted");
      expect(badge.className).toContain("text-accent-text");
    });

    it("SB-TC-079: a Spec Bench in auto mode reads Spec Bench · auto in its variant badge", () => {
      makeDefaultMutations();
      const { unmount } = renderCard(
        makeBench({
          variant: "specbench",
          deliveryBindMode: "launch",
          deliveryDecisionMode: "auto",
        }),
      );
      expect(screen.getByTestId("bench-variant-badge")).toHaveTextContent("Spec Bench · auto");
      unmount();
      renderCard(
        makeBench({
          variant: "specbench",
          deliveryBindMode: "launch",
          deliveryDecisionMode: "attended",
        }),
      );
      expect(screen.getByTestId("bench-variant-badge").textContent).toBe("Spec Bench");
    });

    it("SB-TC-008: shows no variant badge on a plain bench or a TestBench", () => {
      makeDefaultMutations();
      const { unmount } = renderCard(makeBench());
      expect(screen.queryByTestId("bench-variant-badge")).toBeNull();
      unmount();
      renderCard(makeBench({ variant: "testbench" }));
      expect(screen.queryByTestId("bench-variant-badge")).toBeNull();
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

  describe("DESIGN.md bench card frame (#1296)", () => {
    const cases: [Bench["status"], string][] = [
      ["active", "border-status-active"],
      ["preparing", "border-status-preparing"],
      ["clearing", "border-status-preparing"],
      ["error", "border-status-error"],
      ["idle", "border-status-idle"],
    ];
    for (const [status, border] of cases) {
      it(`rests on bg-surface with the ${status} status as its border, and labels the status`, () => {
        makeDefaultMutations();
        renderCard(makeBench({ status }));
        const frame = screen.getByTestId("bench-card-frame");
        expect(frame.className).toContain(border);
        expect(frame.className).toContain("bg-bg-surface");
        expect(frame.className).toContain("group-hover:bg-bg-hover");
        expect(frame.className).toContain("rounded-card");
        expect(screen.getByTestId("bench-card-status")).toHaveTextContent(status);
      });
    }

    it("takes the error border when the bench carries an error", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "idle", error: "boom" }));
      expect(screen.getByTestId("bench-card-frame").className).toContain("border-status-error");
    });
  });

  describe("action buttons", () => {
    // The start/stop and teardown buttons are icon-only IconButtons: the tooltip
    // text is also the accessible name. A disabled IconButton stays focusable
    // (aria-disabled) so its tooltip can still be read.
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
      expect(startStopButton).toHaveAttribute("aria-disabled", "true");
    });

    it("disables start/stop button when bench is clearing", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "clearing" }));
      const [startStopButton] = screen.getAllByRole("button");
      expect(startStopButton).toHaveAttribute("aria-disabled", "true");
    });

    it("disables teardown button when bench is clearing", () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "clearing" }));
      const buttons = screen.getAllByRole("button");
      const teardownButton = buttons[buttons.length - 1];
      expect(teardownButton).toHaveAttribute("aria-disabled", "true");
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
      expect(startButton.className).toContain("bg-accent");
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
      expect(startButton.className).not.toContain("bg-accent");
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
              type: "agent-waiting",
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

    // #985 / #902: React Aria omits aria-modal and strips the prop, so the
    // shared stampAriaModal ref is what makes the modality explicit to AT.
    it("stamps aria-modal on the confirm dialog", async () => {
      makeDefaultMutations();
      renderCard(makeBench({ status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]); // teardown is last
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
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
      // Dirty dialog is open: confirm it
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
      // Dirty dialog opens: cancel it
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

  describe("issue from previous integration badge", () => {
    function renderWithIntegration(bench: Bench, activeIntegrationId: string | null) {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <BenchCard bench={bench} activeIntegrationId={activeIntegrationId} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }

    it("renders the badge when the bench's snapshot integration differs from the project's active one", () => {
      makeDefaultMutations();
      const bench = makeBench({
        assignedIssue: {
          number: 42,
          integrationId: "github-com",
          externalId: "42",
          title: "Wire it up",
        },
      });

      renderWithIntegration(bench, "jira-self-hosted");

      expect(screen.getByTestId("previous-integration-badge")).toBeInTheDocument();
      expect(screen.getByText("Issue from previous integration")).toBeInTheDocument();
    });

    it("does not render the badge when the integrations match", () => {
      makeDefaultMutations();
      const bench = makeBench({
        assignedIssue: {
          number: 42,
          integrationId: "github-com",
          externalId: "42",
          title: "Wire it up",
        },
      });

      renderWithIntegration(bench, "github-com");

      expect(screen.queryByTestId("previous-integration-badge")).not.toBeInTheDocument();
    });

    it("does not render the badge when the bench has no assigned issue", () => {
      makeDefaultMutations();
      renderWithIntegration(makeBench(), "github-com");

      expect(screen.queryByTestId("previous-integration-badge")).not.toBeInTheDocument();
    });

    it("does not render the badge when no active integration is known yet", () => {
      makeDefaultMutations();
      const bench = makeBench({
        assignedIssue: {
          number: 42,
          integrationId: "github-com",
          externalId: "42",
          title: "Wire it up",
        },
      });

      renderWithIntegration(bench, null);

      expect(screen.queryByTestId("previous-integration-badge")).not.toBeInTheDocument();
    });
  });

  describe("Spec Bench delivery record warning", () => {
    const specBench = (overrides: Partial<Bench> = {}) =>
      makeBench({
        variant: "specbench",
        focusedSpecPath: "/repo/.specifications/fixture-spec",
        deliveryBindMode: "launch",
        ...overrides,
      });

    it("warns in the Clear bench dialog that the delivery record goes with the workspace", async () => {
      const { teardownMutate } = makeDefaultMutations();
      renderCard(specBench({ status: "idle" }));
      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      expect(screen.getByTestId("delivery-record-warning")).toHaveTextContent(
        /delivery record .* will be deleted with it/,
      );
      await userEvent.click(screen.getByRole("button", { name: "Clear bench" }));
      expect(teardownMutate).toHaveBeenCalled();
    });

    it("asks for a confirmation before Cleanup & Retry, and retries only once confirmed", async () => {
      const { cleanupMutate } = makeDefaultMutations();
      renderCard(specBench({ id: 3, projectId: "proj-x", status: "error", error: "oops" }));

      await userEvent.click(screen.getByText("Cleanup & Retry"));
      expect(cleanupMutate).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toHaveTextContent(/delivery record .* will be deleted/);
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(cleanupMutate).not.toHaveBeenCalled();

      await userEvent.click(screen.getByText("Cleanup & Retry"));
      await userEvent.click(screen.getByRole("button", { name: "Delete record and retry" }));
      expect(cleanupMutate).toHaveBeenCalledWith(
        { projectId: "proj-x", benchId: 3 },
        expect.objectContaining({ onError: expect.any(Function) }),
      );
    });

    it("shows no warning for a plain bench, which retries on one press", async () => {
      const { cleanupMutate } = makeDefaultMutations();
      renderCard(makeBench({ status: "error", error: "oops" }));
      await userEvent.click(screen.getByText("Cleanup & Retry"));
      expect(cleanupMutate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      const buttons = screen.getAllByRole("button");
      await userEvent.click(buttons[buttons.length - 1]);
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByTestId("delivery-record-warning")).not.toBeInTheDocument();
    });
  });

  describe("Spec Bench delivery summary (#1624)", () => {
    const specBench = (overrides: Partial<Bench> = {}) =>
      makeBench({
        id: 3,
        projectId: "demo",
        status: "active",
        variant: "specbench",
        focusedSpecPath: "/repo/.specifications/fixture-spec",
        deliveryBindMode: "launch",
        ...overrides,
      });

    function withDecisions(): DeliveryRecord {
      const record = fourUnitRecord();
      record.decisions = [
        {
          id: "D-004",
          question: "One file per unit or one per stack?",
          options: ["one file per unit", "one file per stack"],
          default: "one file per unit",
          status: "open",
          raised_at: "2026-10-16T09:05:00Z",
        },
        {
          id: "D-005",
          question: "Split the fixture?",
          options: ["split", "keep"],
          default: "keep",
          status: "open",
          raised_at: "2026-10-16T09:20:00Z",
        },
      ];
      return record;
    }

    function answer(record: DeliveryRecord) {
      const snapshot = foldDelivery({ record, events: [] });
      // Three of ten cases met, so the count and the meter have figures to show.
      snapshot.progress = { ...snapshot.progress, cases: { met: 3, total: 10 } };
      vi.mocked(api.fetchDelivery).mockResolvedValue(snapshot);
    }

    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
    });

    it("shows the slug, cases met, spend, meter, waiting decisions, live unit and health", async () => {
      vi.useFakeTimers({ now: Date.parse("2026-10-16T09:31:00Z"), toFake: ["Date"] });
      makeDefaultMutations();
      answer(withDecisions());
      renderCard(specBench());
      const summary = await screen.findByText("2 decisions waiting");
      const card = summary.closest('[data-testid="specbench-card-summary"]') as HTMLElement;
      expect(card).toHaveTextContent("fixture-spec");
      expect(card).toHaveTextContent("fixture-spec 3 of 10 cases met USD 0.42");
      expect(card).toHaveTextContent("2 decisions waiting A running fresh");
      expect(card).toHaveTextContent("USD 0.42");
      expect(screen.getByTestId("specbench-card-meter")).toHaveStyle({ width: "30%" });
      expect(screen.getByTestId("specbench-card-live")).toHaveTextContent("A running");
      expect(screen.getByTestId("specbench-card-health")).toHaveTextContent("fresh");
      expect(screen.getByRole("button", { name: "Open delivery" })).toBeInTheDocument();
      // The oldest open decision is the one to answer first.
      expect(screen.getByRole("button", { name: "Answer D-004" })).toBeInTheDocument();
      // The branch sits in the head, beside the title.
      expect(screen.getByText("Bench 3").parentElement).toContainElement(
        screen.getByTestId("bench-card-branch"),
      );
    });

    it("lets only a long branch give way in the head, so the title, badge and dot stay whole", () => {
      makeDefaultMutations();
      answer(withDecisions());
      renderCard(
        specBench({
          branch: `delivery/${"very-long-branch-name-".repeat(6)}end`,
          notifications: [
            {
              id: "n1",
              type: "agent-waiting",
              priority: "action-needed",
              createdAt: "2024-01-01T00:00:00Z",
            },
          ],
        }),
      );
      const title = screen.getByText("Bench 3");
      expect(title).toHaveClass("shrink-0", "whitespace-nowrap");
      const head = title.parentElement as HTMLElement;
      expect(within(head).getByRole("img", { name: "Action needed" })).toHaveClass("shrink-0");
      expect(within(head).getByTestId("bench-card-branch")).toHaveClass("min-w-0");
      for (const child of Array.from(head.children)) {
        if (child.getAttribute("data-testid") === "bench-card-branch") continue;
        expect(child).toHaveClass("shrink-0");
      }
    });

    it("opens the Delivery tab from Open delivery, and the decision pile from Answer", async () => {
      makeDefaultMutations();
      mockNavigate.mockClear();
      answer(withDecisions());
      renderCard(specBench());
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Open delivery" }));
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenLastCalledWith("/projects/demo/benches/3");
      expect(localStorage.getItem("roubo-bench-view-state")).toContain('"activeTab":"delivery"');
      await user.click(screen.getByRole("button", { name: "Answer D-004" }));
      expect(mockNavigate).toHaveBeenCalledTimes(2);
      expect(mockNavigate).toHaveBeenLastCalledWith("/projects/demo/benches/3#decisions");
    });

    it("opens the Delivery tab once on Enter on Open delivery, not also through the card's own Enter", async () => {
      makeDefaultMutations();
      mockNavigate.mockClear();
      answer(withDecisions());
      renderCard(specBench());
      const user = userEvent.setup();
      const open = await screen.findByRole("button", { name: "Open delivery" });
      open.focus();
      await user.keyboard("{Enter}");
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith("/projects/demo/benches/3");
    });

    it("reads attached in its health for an attach-mode Spec Bench with no session", async () => {
      makeDefaultMutations();
      answer(fourUnitRecord());
      renderCard(specBench({ deliveryBindMode: "attach" }));
      const health = await screen.findByTestId("specbench-card-health");
      expect(health).toHaveAttribute("data-health", "attached");
      expect(health).toHaveTextContent("attached");
    });

    it("offers no Answer button while no decision waits", async () => {
      makeDefaultMutations();
      answer(fourUnitRecord());
      renderCard(specBench());
      expect(await screen.findByText("no decision waiting")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Answer/ })).toBeNull();
    });

    it("shows a nonconformant record's error and offers Open bench only", async () => {
      makeDefaultMutations();
      mockNavigate.mockClear();
      vi.mocked(api.fetchDelivery).mockRejectedValue(
        new ApiError("missing decisions", 409, "DELIVERY_NONCONFORMANT", {
          error: "missing decisions",
          code: "DELIVERY_NONCONFORMANT",
          section: "decisions",
        }),
      );
      renderCard(specBench());
      const error = await screen.findByTestId("specbench-card-error");
      expect(error).toHaveTextContent("The delivery record is missing its decisions section");
      expect(screen.getByTestId("specbench-card-summary")).toHaveTextContent(
        "fixture-spec The delivery record is missing its decisions section",
      );
      expect(error.className).toContain("text-danger-text");
      expect(screen.getByText("No controls until the record conforms")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open delivery" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Answer/ })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "Open bench" }));
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith("/projects/demo/benches/3");
    });

    it("says a missing record is not there yet, without danger-text, and offers Open bench", async () => {
      makeDefaultMutations();
      vi.mocked(api.fetchDelivery).mockRejectedValue(
        new ApiError("no record", 409, "DELIVERY_RECORD_MISSING", {
          error: "no record",
          code: "DELIVERY_RECORD_MISSING",
        }),
      );
      renderCard(specBench());
      const error = await screen.findByTestId("specbench-card-error");
      expect(error).toHaveTextContent("No delivery record yet");
      expect(error.className).not.toContain("text-danger-text");
      expect(screen.queryByText("No controls until the record conforms")).toBeNull();
      expect(screen.getByRole("button", { name: "Open bench" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open delivery" })).toBeNull();
    });

    it("does not blame the record when the read fails for another reason", async () => {
      makeDefaultMutations();
      vi.mocked(api.fetchDelivery).mockRejectedValue(new Error("Network down"));
      renderCard(specBench());
      expect(await screen.findByTestId("specbench-card-error")).toHaveTextContent(
        "The delivery could not be read",
      );
      expect(screen.queryByText("No controls until the record conforms")).toBeNull();
      expect(screen.getByRole("button", { name: "Open bench" })).toBeInTheDocument();
    });

    it("keeps the component list on a plain bench and a TestBench", () => {
      makeDefaultMutations();
      const components = {
        web: { status: "running", setupComplete: true },
      } as unknown as Bench["components"];
      const { unmount } = renderCard(makeBench({ components }));
      expect(screen.getByText("web")).toBeInTheDocument();
      expect(screen.queryByTestId("specbench-card-summary")).toBeNull();
      expect(screen.getByText("Bench 1").parentElement).not.toContainElement(
        screen.getByTestId("bench-card-branch"),
      );
      unmount();
      renderCard(makeBench({ variant: "testbench", components }));
      expect(screen.getByText("web")).toBeInTheDocument();
      expect(screen.queryByTestId("specbench-card-summary")).toBeNull();
    });
  });
});
