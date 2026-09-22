// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
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

// APCC-NFR-003: the install or update step the agent plugin declares, offered as a
// command to copy and a link, so APCC-TC-036 and APCC-TC-054 S001-O03 hold on
// the surface the user actually sees.
describe("AgentLaunchFailurePanel declared remedy (APCC-NFR-003)", () => {
  const INSTALL = {
    command: "curl https://cursor.com/install -fsS | bash",
    url: "https://cursor.com/docs/cli/installation",
  };

  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  function missing(remedy?: AgentLaunchFailure["remedy"]) {
    return panel(
      {
        class: "missing-binary",
        message: 'Cursor CLI could not start: the "agent" CLI was not found.',
        guidance: "Install the agent CLI by running `curl https://cursor.com/install -fsS | bash`.",
        capturedOutput: undefined,
        ...(remedy !== undefined && { remedy }),
      },
      vi.fn(),
    );
  }

  it("APCC-TC-036: shows the install command and copies it on Copy", () => {
    missing(INSTALL);

    expect(screen.getByTestId("agent-launch-failure-remedy-command")).toHaveTextContent(
      INSTALL.command,
    );
    act(() => {
      screen.getByTestId("agent-launch-failure-remedy-copy").click();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INSTALL.command);
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("APCC-TC-036: links the installation guide in a new window", () => {
    missing(INSTALL);

    const link = screen.getByTestId("agent-launch-failure-remedy-link");
    expect(link).toHaveAttribute("href", INSTALL.url);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("Installation guide");
  });

  it("APCC-TC-054: labels the link as the update guide on a below-floor failure", () => {
    panel(
      {
        class: "below-floor-version",
        message:
          "Cursor CLI requires CLI version 2026.09.08 or newer, but 2026.09.01 is installed.",
        capturedOutput: undefined,
        remedy: { command: "agent update", url: "https://cursor.com/docs/cli/installation" },
      },
      vi.fn(),
    );

    expect(screen.getByTestId("agent-launch-failure-remedy-command")).toHaveTextContent(
      "agent update",
    );
    expect(screen.getByTestId("agent-launch-failure-remedy-link")).toHaveTextContent(
      "Update guide",
    );
  });

  it("renders no link for a url that is not http or https", () => {
    missing({ command: "acme-installer", url: "javascript:alert(1)" });

    expect(screen.getByTestId("agent-launch-failure-remedy-command")).toBeTruthy();
    expect(screen.queryByTestId("agent-launch-failure-remedy-link")).toBeNull();
  });

  it("renders only the guide link for a step that declares a url and no command", () => {
    missing({ url: INSTALL.url });

    expect(screen.getByTestId("agent-launch-failure-remedy-link")).toHaveAttribute(
      "href",
      INSTALL.url,
    );
    expect(screen.queryByTestId("agent-launch-failure-remedy-command")).toBeNull();
    expect(screen.queryByTestId("agent-launch-failure-remedy-copy")).toBeNull();
  });

  it("renders no remedy block when its only field is a url that is not http or https", () => {
    missing({ url: "javascript:alert(1)" });

    expect(screen.queryByTestId("agent-launch-failure-remedy")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("was not found");
  });

  it("renders nothing extra when the plugin declares no step", () => {
    missing();

    expect(screen.queryByTestId("agent-launch-failure-remedy")).toBeNull();
    expect(screen.getByTestId("agent-launch-failure-settings")).toBeTruthy();
    expect(screen.getByTestId("agent-launch-failure-retry")).toBeTruthy();
  });
});
