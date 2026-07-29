// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AgentLaunchFailure } from "@roubo/shared";
import AgentLaunchFailurePanel from "./AgentLaunchFailurePanel";

function panel(failure: Partial<AgentLaunchFailure> = {}, onRetry?: () => void) {
  const full: AgentLaunchFailure = {
    class: "launch-failure",
    message: "Codex CLI failed to launch: exited in 0.4s.",
    guidance: "Check the agent's arguments in its plugin settings, or update the plugin.",
    capturedOutput: "error: unexpected argument '--yolo-mode' found",
    actions: ["open-plugin-settings", "retry"],
    ...failure,
  };
  return render(
    <MemoryRouter>
      <AgentLaunchFailurePanel failure={full} {...(onRetry !== undefined && { onRetry })} />
    </MemoryRouter>,
  );
}

describe("AgentLaunchFailurePanel (AP-TC-075, AP-TC-077)", () => {
  it("shows the message, the captured stderr, and both recovery actions", () => {
    panel({}, vi.fn());

    expect(screen.getByRole("alert")).toHaveTextContent("failed to launch: exited in 0.4s");
    expect(screen.getByTestId("agent-launch-failure-output")).toHaveTextContent(
      "error: unexpected argument '--yolo-mode' found",
    );
    expect(screen.getByTestId("agent-launch-failure-settings")).toHaveAttribute(
      "href",
      "/settings#ai-agents",
    );
    expect(screen.getByTestId("agent-launch-failure-retry")).toBeTruthy();
  });

  it("calls onRetry when Retry is pressed", async () => {
    const onRetry = vi.fn();
    panel({}, onRetry);

    await userEvent.click(screen.getByTestId("agent-launch-failure-retry"));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("omits an action the failure does not declare", () => {
    panel({ class: "host-install-broken", actions: ["retry"] }, vi.fn());

    expect(screen.queryByTestId("agent-launch-failure-settings")).toBeNull();
    expect(screen.getByTestId("agent-launch-failure-retry")).toBeTruthy();
  });

  it("still renders the message when there was no captured output (AP-TC-058)", () => {
    panel(
      {
        class: "missing-binary",
        message: 'Claude Code could not start: the "claude" CLI was not found.',
        guidance: "Install the agent CLI, or point Claude Code at an existing install.",
        capturedOutput: undefined,
        actions: ["open-plugin-settings", "retry"],
      },
      vi.fn(),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("was not found");
    expect(screen.queryByTestId("agent-launch-failure-output")).toBeNull();
    expect(screen.getByTestId("agent-launch-failure")).toHaveAttribute(
      "data-failure-class",
      "missing-binary",
    );
  });

  it("hides Retry when the surface offers no retry handler", () => {
    panel();
    expect(screen.queryByTestId("agent-launch-failure-retry")).toBeNull();
  });
});
