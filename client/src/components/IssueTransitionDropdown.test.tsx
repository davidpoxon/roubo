// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IssueTransitionDropdown from "./IssueTransitionDropdown";
import { ApiError } from "../lib/api";
import * as api from "../lib/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    applyTransition: vi.fn(),
  };
});

const mockedApplyTransition = vi.mocked(api.applyTransition);

beforeEach(() => {
  vi.resetAllMocks();
});

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("IssueTransitionDropdown", () => {
  it("TC-039: lists exactly the issue's allowedTransitions and nothing else", async () => {
    const user = userEvent.setup();
    renderWithClient(
      <IssueTransitionDropdown
        projectId="p1"
        externalId="ROUBO-42"
        currentState="To Do"
        allowedTransitions={["In Review", "Blocked"]}
      />,
    );

    await user.click(screen.getByTestId("transition-trigger"));

    const listbox = await screen.findByRole("listbox", { name: /available transitions/i });
    const options = listbox.querySelectorAll('[role="option"]');
    const labels = Array.from(options).map((el) => el.textContent);
    expect(labels).toEqual(["In Review", "Blocked"]);
    // No other states (TC-039 explicit negative assertion)
    expect(labels).not.toContain("Done");
    expect(labels).not.toContain("To Do");
  });

  it("TC-039 (empty): renders no-transitions message and a non-interactive pill when allowedTransitions is empty", () => {
    renderWithClient(
      <IssueTransitionDropdown
        projectId="p1"
        externalId="ROUBO-42"
        currentState="Done"
        allowedTransitions={[]}
      />,
    );

    expect(screen.getByText("No transitions available from this state.")).toBeInTheDocument();
    const pill = screen.getByTestId("transition-pill-readonly");
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toBe("Done");
    expect(screen.queryByTestId("transition-trigger")).not.toBeInTheDocument();
  });

  it("TC-054: selecting a transition optimistically flips the pill and calls applyTransition", async () => {
    const user = userEvent.setup();
    // Keep the mutation pending so we can observe the optimistic state before resolve.
    let resolvePromise: (value: Awaited<ReturnType<typeof api.applyTransition>>) => void = () => {};
    mockedApplyTransition.mockImplementation(
      () =>
        new Promise<Awaited<ReturnType<typeof api.applyTransition>>>((resolve) => {
          resolvePromise = resolve;
        }),
    );

    renderWithClient(
      <IssueTransitionDropdown
        projectId="p1"
        externalId="ROUBO-42"
        currentState="To Do"
        allowedTransitions={["In Review", "Done"]}
      />,
    );

    await user.click(screen.getByTestId("transition-trigger"));
    const option = await screen.findByRole("option", { name: "In Review" });
    await user.click(option);

    // Optimistic flip happens before the mutation resolves.
    expect(screen.getByTestId("transition-trigger").textContent).toContain("In Review");
    expect(mockedApplyTransition).toHaveBeenCalledWith("p1", "ROUBO-42", "In Review");

    resolvePromise({
      integrationId: "github-com",
      externalId: "ROUBO-42",
      externalUrl: "https://example/issues/ROUBO-42",
      title: "T",
      body: null,
      currentState: "In Review",
      allowedTransitions: ["Done"],
      assignees: [],
      labels: [],
      issueType: null,
      blocks: [],
      blockedBy: [],
      updatedAt: "2024-01-01T00:00:00Z",
      raw: null,
    });
  });

  it("TC-063: on plugin error, reverts the optimistic update and surfaces the verbatim error in an inline banner", async () => {
    const user = userEvent.setup();
    const verbatim = "Your token lacks permission to transition this workflow.";
    mockedApplyTransition.mockRejectedValue(
      new ApiError("rpc-error", 502, undefined, { error: "rpc-error", message: verbatim }),
    );

    renderWithClient(
      <IssueTransitionDropdown
        projectId="p1"
        externalId="ROUBO-42"
        currentState="To Do"
        allowedTransitions={["Done"]}
      />,
    );

    await user.click(screen.getByTestId("transition-trigger"));
    await user.click(await screen.findByRole("option", { name: "Done" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(verbatim);

    // Optimistic state reverted to "To Do".
    await waitFor(() => {
      expect(screen.getByTestId("transition-trigger").textContent).toContain("To Do");
    });
  });

  it("TC-064: applyTransition is not called on mount, re-render, or without user interaction (lifecycle events)", () => {
    // Bench lifecycle events (create / start / clear / PR merge) deliberately
    // do not call applyTransition anywhere in the codebase. This test guards
    // the component itself: mounting and re-rendering with the same props
    // must never trigger a transition.
    const { rerender } = renderWithClient(
      <IssueTransitionDropdown
        projectId="p1"
        externalId="ROUBO-42"
        currentState="To Do"
        allowedTransitions={["In Review", "Done"]}
      />,
    );

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <IssueTransitionDropdown
          projectId="p1"
          externalId="ROUBO-42"
          currentState="To Do"
          allowedTransitions={["In Review", "Done"]}
        />
      </QueryClientProvider>,
    );

    expect(mockedApplyTransition).not.toHaveBeenCalled();
  });

  it("re-syncs the pill to the source when currentState prop changes (refresh reconciliation)", () => {
    const { rerender } = renderWithClient(
      <IssueTransitionDropdown
        projectId="p1"
        externalId="ROUBO-42"
        currentState="To Do"
        allowedTransitions={["In Review", "Done"]}
      />,
    );
    expect(screen.getByTestId("transition-trigger").textContent).toContain("To Do");

    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <IssueTransitionDropdown
          projectId="p1"
          externalId="ROUBO-42"
          currentState="Done"
          allowedTransitions={[]}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("No transitions available from this state.")).toBeInTheDocument();
    expect(screen.getByTestId("transition-pill-readonly").textContent).toBe("Done");
  });
});
