// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionUnexpectedExit } from "@roubo/shared";
import AgentUnexpectedExitPanel from "./AgentUnexpectedExitPanel";

const KILLED: SessionUnexpectedExit = {
  exitCode: 137,
  signal: "SIGKILL",
  timeToExitMs: 45 * 60 * 1000,
  endedAt: "2026-10-07T09:00:00.000Z",
};

describe("AgentUnexpectedExitPanel", () => {
  it("names the cause and how long the session ran", () => {
    render(<AgentUnexpectedExitPanel exit={KILLED} />);

    const panel = screen.getByRole("alert");
    expect(panel).toHaveTextContent("The AI coding agent ended unexpectedly");
    expect(screen.getByTestId("agent-unexpected-exit-cause")).toHaveTextContent(
      "Ended with SIGKILL (exit 137) after running for 45 minutes.",
    );
  });

  it("explains a SIGKILL without claiming it was an out-of-memory kill", () => {
    render(<AgentUnexpectedExitPanel exit={KILLED} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This often means the system ran out of memory.",
    );
  });

  it("names a plain nonzero exit by its code and adds no hint", () => {
    render(<AgentUnexpectedExitPanel exit={{ ...KILLED, exitCode: 3, signal: null }} />);

    expect(screen.getByTestId("agent-unexpected-exit-cause")).toHaveTextContent(
      "Ended with exit code 3",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("ran out of memory");
  });

  it("names no specific AI coding tool", () => {
    render(<AgentUnexpectedExitPanel exit={KILLED} label="Session 1" />);

    expect(screen.getByRole("alert").textContent).not.toMatch(/claude|codex|gemini|copilot/i);
  });

  it("shows the session label only when given one", () => {
    const { rerender } = render(<AgentUnexpectedExitPanel exit={KILLED} />);
    expect(screen.queryByTestId("agent-unexpected-exit-label")).toBeNull();

    rerender(<AgentUnexpectedExitPanel exit={KILLED} label="Session 2 - demo #1" />);
    expect(screen.getByTestId("agent-unexpected-exit-label")).toHaveTextContent(
      "Session 2 - demo #1",
    );
  });

  it("offers a dismiss control only when the caller can act on it", async () => {
    const { rerender } = render(<AgentUnexpectedExitPanel exit={KILLED} />);
    expect(screen.queryByTestId("agent-unexpected-exit-dismiss")).toBeNull();

    const onDismiss = vi.fn();
    rerender(<AgentUnexpectedExitPanel exit={KILLED} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByTestId("agent-unexpected-exit-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses a distinct test id per variant", () => {
    const { rerender } = render(<AgentUnexpectedExitPanel exit={KILLED} />);
    expect(screen.getByTestId("agent-unexpected-exit")).toBeInTheDocument();

    rerender(<AgentUnexpectedExitPanel exit={KILLED} variant="inline" />);
    expect(screen.getByTestId("agent-unexpected-exit-inline")).toBeInTheDocument();
  });
});
