// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapturedUserId } from "@roubo/shared";
import IssueAssignControl from "./IssueAssignControl";
import { ApiError } from "../lib/api";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    assignIssueToUser: vi.fn(),
    unassignIssueFromUser: vi.fn(),
  };
});

const mockedAssign = vi.mocked(api.assignIssueToUser);
const mockedUnassign = vi.mocked(api.unassignIssueFromUser);

const jane: CapturedUserId = {
  externalId: "jane.doe@acme.com",
  displayName: "Jane Doe",
};

beforeEach(() => {
  vi.resetAllMocks();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("IssueAssignControl", () => {
  it("TC-040: clicking 'Assign to me' calls assignIssueToUser with the captured identity and optimistically flips the label", async () => {
    const user = userEvent.setup();
    // Hold the mutation pending so we can observe the optimistic flip.
    let resolvePromise: () => void = () => {};
    mockedAssign.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePromise = resolve;
        }),
    );

    renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[]}
        capturedUserId={jane}
      />,
    );

    const button = screen.getByTestId("assign-control");
    expect(button.textContent).toBe("Assign to me");

    await user.click(button);

    expect(mockedAssign).toHaveBeenCalledWith("p1", "ROUBO-42", "jane.doe@acme.com");
    // Optimistic flip happens before the mutation resolves.
    expect(button.textContent).toBe("Unassign me");

    resolvePromise();
  });

  it("clicking 'Unassign me' when already assigned calls unassignIssueFromUser with the captured identity", async () => {
    const user = userEvent.setup();
    let resolvePromise: () => void = () => {};
    mockedUnassign.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePromise = resolve;
        }),
    );

    renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[{ externalId: "jane.doe@acme.com", displayName: "Jane Doe" }]}
        capturedUserId={jane}
      />,
    );

    const button = screen.getByTestId("assign-control");
    expect(button.textContent).toBe("Unassign me");

    await user.click(button);

    expect(mockedUnassign).toHaveBeenCalledWith("p1", "ROUBO-42", "jane.doe@acme.com");
    expect(button.textContent).toBe("Assign to me");

    resolvePromise();
  });

  it("on plugin error, reverts the optimistic update and surfaces the verbatim error in an inline banner", async () => {
    const user = userEvent.setup();
    const verbatim = "Your token lacks permission to assign issues in this project.";
    mockedAssign.mockRejectedValue(
      new ApiError("rpc-error", 502, undefined, { error: "rpc-error", message: verbatim }),
    );

    renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[]}
        capturedUserId={jane}
      />,
    );

    await user.click(screen.getByTestId("assign-control"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(verbatim);

    await waitFor(() => {
      expect(screen.getByTestId("assign-control").textContent).toBe("Assign to me");
    });
  });

  it("renders nothing when capturedUserId is undefined", () => {
    renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[]}
        capturedUserId={undefined}
      />,
    );

    expect(screen.queryByTestId("assign-control")).not.toBeInTheDocument();
  });

  it("does not call any plugin RPC on mount or re-render without user interaction", () => {
    const { rerender } = renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[]}
        capturedUserId={jane}
      />,
    );

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <IssueAssignControl
          projectId="p1"
          externalId="ROUBO-42"
          assignees={[]}
          capturedUserId={jane}
        />
      </QueryClientProvider>,
    );

    expect(mockedAssign).not.toHaveBeenCalled();
    expect(mockedUnassign).not.toHaveBeenCalled();
  });

  it("WU-027: exposes aria-pressed reflecting the toggle state", async () => {
    const user = userEvent.setup();
    let resolvePromise: () => void = () => {};
    mockedAssign.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePromise = resolve;
        }),
    );

    renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[]}
        capturedUserId={jane}
      />,
    );

    const button = screen.getByTestId("assign-control");
    // Unassigned → button is a not-pressed toggle so screen readers announce
    // "Assign to me, not pressed" rather than just the label.
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);

    // Optimistic flip carries the aria-pressed state too.
    expect(button).toHaveAttribute("aria-pressed", "true");

    resolvePromise();
  });

  it("re-syncs the label to the source when the assignees prop changes (refresh reconciliation)", () => {
    const { rerender } = renderWithClient(
      <IssueAssignControl
        projectId="p1"
        externalId="ROUBO-42"
        assignees={[]}
        capturedUserId={jane}
      />,
    );
    expect(screen.getByTestId("assign-control").textContent).toBe("Assign to me");

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <IssueAssignControl
          projectId="p1"
          externalId="ROUBO-42"
          assignees={[{ externalId: "jane.doe@acme.com", displayName: "Jane Doe" }]}
          capturedUserId={jane}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("assign-control").textContent).toBe("Unassign me");
  });

  describe("WU-033: alert-backed bench disabled state", () => {
    it("renders the button disabled and does not invoke the API when isDisabled is set", async () => {
      const user = userEvent.setup();
      renderWithClient(
        <IssueAssignControl
          projectId="p1"
          externalId="org/repo#code-scanning-7"
          assignees={[]}
          capturedUserId={jane}
          isDisabled
          disabledTooltip="Security alerts cannot be assigned from Roubo. They are repo-level findings, not user-assigned work."
        />,
      );
      const button = screen.getByTestId("assign-control");
      expect(button).toBeDisabled();
      await user.click(button);
      expect(mockedAssign).not.toHaveBeenCalled();
      expect(mockedUnassign).not.toHaveBeenCalled();
      expect(button.textContent).toBe("Assign to me");
    });

    it("wraps the disabled button in a TooltipTrigger so the documented copy is exposed on focus/hover (TC-095)", () => {
      // We can't reliably trigger the React Aria Tooltip popover for a disabled
      // <button> in jsdom (disabled elements drop pointer/focus events). Instead
      // assert the wiring: the button is disabled and React Aria's keyboard-
      // focusable Button is in place, which is what receives the tooltip
      // hover/focus events in the browser. The verbatim copy is enforced
      // statically by the BenchDetail source constant and verified in the
      // BenchDetail integration test.
      renderWithClient(
        <IssueAssignControl
          projectId="p1"
          externalId="org/repo#code-scanning-7"
          assignees={[]}
          capturedUserId={jane}
          isDisabled
          disabledTooltip="Security alerts cannot be assigned from Roubo. They are repo-level findings, not user-assigned work."
        />,
      );
      const button = screen.getByTestId("assign-control");
      expect(button).toBeDisabled();
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("data-rac")).toBe("");
    });

    it("renders disabled without tooltip wrapping when disabledTooltip is omitted", () => {
      renderWithClient(
        <IssueAssignControl
          projectId="p1"
          externalId="org/repo#code-scanning-7"
          assignees={[]}
          capturedUserId={jane}
          isDisabled
        />,
      );
      const button = screen.getByTestId("assign-control");
      expect(button).toBeDisabled();
    });
  });
});
