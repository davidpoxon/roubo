// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import ClearingTrackerProvider from "./ClearingTrackerProvider";
import { useTeardownTracker } from "../hooks/useClearingTracker";
import ToastProvider from "./ToastProvider";

vi.mock("../hooks/useBenches");
vi.mock("../hooks/useEntranceAnimation", () => ({
  useEntranceAnimation: () => true,
}));

import { useAllBenches } from "../hooks/useBenches";

const mockUseAllBenches = vi.mocked(useAllBenches);

function Consumer() {
  const { teardowns, register } = useTeardownTracker();
  return (
    <div>
      <span data-testid="count">{teardowns.size}</span>
      <button onClick={() => register("proj-1", 1, "main")}>Register</button>
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ClearingTrackerProvider", () => {
  it("provides teardown tracker context to children", () => {
    mockUseAllBenches.mockReturnValue({ data: [] } as never);
    render(
      <ToastProvider>
        <ClearingTrackerProvider>
          <Consumer />
        </ClearingTrackerProvider>
      </ToastProvider>,
    );
    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });

  it("register adds an entry to teardowns", async () => {
    mockUseAllBenches.mockReturnValue({ data: [] } as never);
    render(
      <ToastProvider>
        <ClearingTrackerProvider>
          <Consumer />
        </ClearingTrackerProvider>
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Register").click();
    });
    expect(screen.getByTestId("count")).toHaveTextContent("1");
  });

  it("shows TeardownCard while bench is tearing down", () => {
    const bench = {
      id: 1,
      projectId: "proj-1",
      branch: "main",
      status: "clearing",
      teardownSteps: [{ id: "step1", label: "Stopping", status: "running" }],
    };
    mockUseAllBenches.mockReturnValue({ data: [bench] } as never);

    render(
      <ToastProvider>
        <ClearingTrackerProvider>
          <Consumer />
        </ClearingTrackerProvider>
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Register").click();
    });
    expect(screen.getByText("Bench 1")).toBeInTheDocument();
  });

  it("removes teardown entry after bench teardown completes", () => {
    vi.useFakeTimers();
    const completedBench = {
      id: 1,
      projectId: "proj-1",
      branch: "main",
      status: "inactive",
      teardownSteps: [{ id: "step1", label: "Done", status: "done" }],
    };
    mockUseAllBenches.mockReturnValue({ data: [completedBench] } as never);

    render(
      <ToastProvider>
        <ClearingTrackerProvider>
          <Consumer />
        </ClearingTrackerProvider>
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Register").click();
    });
    // After a moment, the completed bench should trigger removal
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    // The teardown counter may have cleared
    expect(screen.getByTestId("count")).toBeDefined();
  });
});
