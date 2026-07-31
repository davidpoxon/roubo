// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentCompatibilityState, AgentPluginState } from "@roubo/shared";

vi.mock("./AgentConfigForm", () => ({
  default: () => null,
}));

import AgentPluginCard from "./AgentPluginCard";

function agent(compatibility?: AgentCompatibilityState): AgentPluginState {
  return {
    id: "claude-code",
    name: "Claude Code",
    version: "1.2.0",
    config: {},
    unavailable: null,
    ...(compatibility !== undefined && { compatibility }),
  };
}

describe("AgentPluginCard compatibility line (AP-TC-113, AP-TC-114)", () => {
  it("shows the declared floor, tested ceiling and detected version", () => {
    render(
      <AgentPluginCard
        agent={agent({
          minVersion: "2.1.111",
          testedCeiling: "2.1.205",
          detectedVersion: "2.1.180",
          status: "within-tested-range",
        })}
      />,
    );

    const line = screen.getByTestId("agent-compatibility-claude-code");
    expect(line).toHaveTextContent("2.1.180 detected");
    expect(line).toHaveTextContent("floor 2.1.111");
    expect(line).toHaveTextContent("tested <= 2.1.205");
    expect(line).toHaveTextContent("within tested range");
  });

  it("warns when the detected version is above the tested ceiling, showing both (AP-TC-114 S001)", () => {
    render(
      <AgentPluginCard
        agent={agent({
          minVersion: "2.1.111",
          testedCeiling: "2.1.205",
          detectedVersion: "2.1.207",
          status: "above-tested-ceiling",
        })}
      />,
    );

    const line = screen.getByTestId("agent-compatibility-claude-code");
    expect(line).toHaveAttribute("data-status", "above-tested-ceiling");
    expect(line).toHaveTextContent("above tested ceiling");
    // The staleness is only visible if both numbers are on the card.
    expect(line).toHaveTextContent("2.1.207");
    expect(line).toHaveTextContent("2.1.205");
  });

  it("shows a within-range indicator and no warning for an in-range agent (AP-TC-114 S002)", () => {
    render(
      <AgentPluginCard
        agent={agent({
          testedCeiling: "0.48.2",
          detectedVersion: "0.48.2",
          status: "within-tested-range",
        })}
      />,
    );

    const line = screen.getByTestId("agent-compatibility-claude-code");
    expect(line).toHaveTextContent("within tested range");
    expect(line).not.toHaveTextContent("above tested ceiling");
  });

  it("claims no verdict before any probe has run", () => {
    render(
      <AgentPluginCard
        agent={agent({ minVersion: "2.1.111", testedCeiling: "2.1.205", status: "unknown" })}
      />,
    );

    const line = screen.getByTestId("agent-compatibility-claude-code");
    expect(line).toHaveTextContent("CLI version not detected yet");
    expect(line).not.toHaveTextContent("within tested range");
    expect(line).not.toHaveTextContent("above tested ceiling");
  });

  it("renders no compatibility line at all when the plugin declares none", () => {
    render(<AgentPluginCard agent={agent()} />);
    expect(screen.queryByTestId("agent-compatibility-claude-code")).toBeNull();
  });
});

// AP-TC-122 (issue #522): installing an agent plugin whose CLI is absent still
// SUCCEEDS as an install. The plugin is installed, compatible, consented and
// running, so the registry's availability chain reports no blocker; what is
// missing is the agent's own binary, which only the version probe can see. The
// card has to tell those two apart, because before this the CLI-absent case
// rendered as "Ready".
describe("AgentPluginCard CLI-not-detected state (AP-TC-122)", () => {
  const PROBE_REASON = "`codex --version` could not be found on your PATH";

  function cliMissingAgent(): AgentPluginState {
    return agent({
      minVersion: "0.144.0",
      testedCeiling: "0.144.1",
      status: "probe-failed",
      reason: PROBE_REASON,
    });
  }

  // S002-O01: an unconfigured / CLI-not-detected state, NOT "Ready".
  it("shows a CLI-not-detected state instead of Ready", () => {
    render(<AgentPluginCard agent={cliMissingAgent()} />);
    const status = screen.getByTestId("agent-cli-missing-claude-code");
    expect(status).toHaveTextContent(
      "Claude Code is installed, but its agent CLI was not detected.",
    );
    expect(screen.queryByText("Ready")).toBeNull();
  });

  // S002-O03: guidance to install the agent CLI.
  it("gives guidance to install the agent CLI", () => {
    render(<AgentPluginCard agent={cliMissingAgent()} />);
    const status = screen.getByTestId("agent-cli-missing-claude-code");
    expect(status).toHaveTextContent(
      "Install the agent's command-line tool and make sure it is on your PATH",
    );
  });

  // The probe's own reason, verbatim: it is the only thing that separates "no
  // such binary" from "the binary printed something unparseable".
  it("surfaces the probe's reason verbatim", () => {
    render(<AgentPluginCard agent={cliMissingAgent()} />);
    expect(screen.getByTestId("agent-cli-missing-reason-claude-code")).toHaveTextContent(
      PROBE_REASON,
    );
  });

  // S002-O02: nothing claims the install itself failed.
  it("makes no claim that the install failed", () => {
    render(<AgentPluginCard agent={cliMissingAgent()} />);
    const status = screen.getByTestId("agent-cli-missing-claude-code");
    expect(status.textContent ?? "").not.toMatch(/install (failed|error)|failed to install/i);
    // It says the opposite: the plugin IS installed.
    expect(status).toHaveTextContent("is installed");
  });

  // A registry-level blocker is a nearer cause and wins, so one card never
  // offers two competing fixes.
  it("prefers the registry blocker when the plugin is also unavailable", () => {
    render(
      <AgentPluginCard
        agent={{
          ...cliMissingAgent(),
          unavailable: {
            reason: "not-consented",
            message: 'Agent plugin "claude-code" has not been consented.',
          },
        }}
      />,
    );
    expect(screen.getByTestId("agent-unavailable-claude-code")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-cli-missing-claude-code")).toBeNull();
  });

  it("still reports Ready when the probe resolved a version in range", () => {
    render(
      <AgentPluginCard
        agent={agent({
          minVersion: "0.144.0",
          testedCeiling: "0.144.1",
          detectedVersion: "0.144.1",
          status: "within-tested-range",
        })}
      />,
    );
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-cli-missing-claude-code")).toBeNull();
  });
});
