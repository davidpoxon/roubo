// @vitest-environment jsdom
//
// #702 (FR-012, TC-027): the gate-state panel renders the gate's status with a
// visible text label (never colour alone), and for a non-passed gate lists the
// unresolved gating cases and the covering slice units. A passed gate shows
// neither set. axe-clean.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { GateState } from "../../lib/api";
import GateStatePanel from "./GateStatePanel";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}
expect.extend({ toHaveNoViolations });

const nonPassed: GateState = {
  gateId: "WU-099",
  status: "failed",
  unresolvedCaseIds: ["TC-001", "TC-002"],
  gatingCaseIds: ["TC-001", "TC-002"],
  coveringUnitIds: ["WU-010"],
  blockedBy: [],
  signedOff: false,
};

describe("GateStatePanel", () => {
  it("renders the gate id and a text status label (not colour alone)", () => {
    render(<GateStatePanel gate={nonPassed} />);
    expect(screen.getByText("WU-099")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("lists the unresolved cases and covering units for a non-passed gate", () => {
    render(<GateStatePanel gate={nonPassed} />);
    expect(screen.getByText("TC-001")).toBeTruthy();
    expect(screen.getByText("TC-002")).toBeTruthy();
    expect(screen.getByText("WU-010")).toBeTruthy();
  });

  it("shows no unresolved/covering ids for a passed gate", () => {
    render(
      <GateStatePanel
        gate={{
          gateId: "WU-099",
          status: "passed",
          unresolvedCaseIds: [],
          gatingCaseIds: [],
          coveringUnitIds: [],
          blockedBy: [],
          signedOff: false,
        }}
      />,
    );
    expect(screen.getByText("Passed")).toBeTruthy();
    expect(screen.queryByText("Unresolved cases")).toBeNull();
    expect(screen.getByText(/Nothing outstanding/)).toBeTruthy();
  });

  it("renders a distinct 'no gating cases in scope' message, not the passed message (#436)", () => {
    render(
      <GateStatePanel
        gate={{
          gateId: "WU-099",
          status: "no_gating_cases",
          unresolvedCaseIds: [],
          gatingCaseIds: [],
          coveringUnitIds: [],
          blockedBy: [],
          signedOff: false,
        }}
      />,
    );
    expect(screen.getByText("No gating cases")).toBeTruthy();
    expect(screen.getByText(/no gating cases in scope/i)).toBeTruthy();
    // Never the passed message, and never the unresolved block.
    expect(screen.queryByText(/All gating cases passed/)).toBeNull();
    expect(screen.queryByText("Unresolved cases")).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = render(<GateStatePanel gate={nonPassed} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
