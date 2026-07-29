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
