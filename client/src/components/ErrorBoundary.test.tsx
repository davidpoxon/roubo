// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.ReactNode {
  if (shouldThrow) throw new Error("kaboom in render");
  return <div>recovered child</div>;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs caught render errors, and ErrorBoundary.componentDidCatch logs
  // intentionally. Silence + assert rather than letting it pollute test output.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("ErrorBoundary", () => {
  it("renders children when they do not throw", () => {
    render(
      <ErrorBoundary>
        <div>healthy content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("healthy content")).toBeInTheDocument();
    expect(screen.queryByTestId("error-boundary-fallback")).not.toBeInTheDocument();
  });

  it("renders a recoverable fallback (not a blank tree) when a child throws", () => {
    render(
      <ErrorBoundary area="settings">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );

    const fallback = screen.getByTestId("error-boundary-fallback");
    expect(fallback).toBeInTheDocument();
    expect(screen.getByText(/Something went wrong in settings/)).toBeInTheDocument();
    expect(screen.getByText(/kaboom in render/)).toBeInTheDocument();
    // Reload affordance is present so the user can recover.
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    // componentDidCatch logged the error (verified, and silenced).
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("clears the error and re-renders children when resetKey changes", () => {
    const { rerender } = render(
      <ErrorBoundary resetKey="/a">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary-fallback")).toBeInTheDocument();

    // Navigating (resetKey change) to a route whose child no longer throws.
    rerender(
      <ErrorBoundary resetKey="/b">
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.queryByTestId("error-boundary-fallback")).not.toBeInTheDocument();
    expect(screen.getByText("recovered child")).toBeInTheDocument();
  });
});
