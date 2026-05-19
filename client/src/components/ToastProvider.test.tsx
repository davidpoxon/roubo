// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import ToastProvider from "./ToastProvider";
import { useToast } from "../hooks/useToast";

// Mock useEntranceAnimation so Toast renders immediately as visible
vi.mock("../hooks/useEntranceAnimation", () => ({
  useEntranceAnimation: () => true,
}));

function ToastConsumer() {
  const { addToast, removeToast } = useToast();
  return (
    <div>
      <button onClick={() => addToast("Hello toast")}>Add</button>
      <button
        onClick={() => addToast("With action", { action: { label: "Undo", onPress: vi.fn() } })}
      >
        Add with action
      </button>
      <button onClick={() => addToast("Fast toast", { duration: 100 })}>Add fast</button>
      <button
        onClick={() => {
          const id = addToast("Removable");
          removeToast(id);
        }}
      >
        Add and remove
      </button>
    </div>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ToastProvider", () => {
  it("renders children", () => {
    render(
      <ToastProvider>
        <div data-testid="child">child</div>
      </ToastProvider>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("addToast shows a message", () => {
    render(
      <ToastProvider>
        <ToastConsumer />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Add").click();
    });
    expect(screen.getByText("Hello toast")).toBeInTheDocument();
  });

  it("renders action button when toast has an action", () => {
    render(
      <ToastProvider>
        <ToastConsumer />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Add with action").click();
    });
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("removeToast starts exit animation and removes toast", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastConsumer />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Add and remove").click();
    });
    // After 200ms animation timer, toast is removed from DOM
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByText("Removable")).not.toBeInTheDocument();
  });

  it("auto-removes toast after duration", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <ToastConsumer />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Add fast").click();
    });
    expect(screen.getByText("Fast toast")).toBeInTheDocument();
    // Advance past the 100ms duration + 200ms exit animation
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.queryByText("Fast toast")).not.toBeInTheDocument();
  });

  it("multiple toasts can coexist", () => {
    render(
      <ToastProvider>
        <ToastConsumer />
      </ToastProvider>,
    );
    act(() => {
      screen.getByText("Add").click();
    });
    act(() => {
      screen.getByText("Add").click();
    });
    expect(screen.getAllByText("Hello toast")).toHaveLength(2);
  });
});
