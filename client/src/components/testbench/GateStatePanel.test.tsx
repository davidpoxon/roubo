// @vitest-environment jsdom
//
// #702 (VG-FR-012, VG-TC-027): the gate-state panel renders the gate's status with a
// visible text label (never colour alone), and for a non-passed gate lists the
// unresolved gating cases and the covering slice units. A passed gate shows
// neither set. axe-clean.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import type { GateState } from "../../lib/api";
import GateStatePanel from "./GateStatePanel";
import { expectNoAxeFindings } from "../../test/axe";

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

  // #777 (SATCA-TC-033 S003-O02): retiring the case that held a gate pending
  // releases it, and the released gate would otherwise be indistinguishable from
  // one whose cases were all verified. The exclusion line is what tells them apart.
  describe("lifecycle exclusion (#777)", () => {
    const released: GateState = {
      gateId: "WU-099",
      status: "passed",
      unresolvedCaseIds: [],
      gatingCaseIds: ["TC-001"],
      coveringUnitIds: [],
      lifecycleExcludedCaseIds: ["TC-002"],
      blockedBy: [],
      signedOff: false,
    };

    it("states the lifecycle exclusion on a PASSED gate, naming the excluded case", () => {
      render(<GateStatePanel gate={released} />);
      expect(screen.getByText("Passed")).toBeTruthy();
      const line = screen.getByTestId("gate-lifecycle-excluded");
      expect(line.textContent).toContain("Excluded by lifecycle");
      expect(line.textContent).toContain("TC-002");
    });

    it("states it on a non-passed gate too, alongside the unresolved set", () => {
      render(<GateStatePanel gate={{ ...nonPassed, lifecycleExcludedCaseIds: ["TC-003"] }} />);
      expect(screen.getByText("TC-001")).toBeTruthy();
      expect(screen.getByTestId("gate-lifecycle-excluded").textContent).toContain("TC-003");
    });

    it("renders nothing when lifecycle excluded nothing, including on a response that predates the field", () => {
      render(<GateStatePanel gate={nonPassed} />);
      expect(screen.queryByTestId("gate-lifecycle-excluded")).toBeNull();
      render(<GateStatePanel gate={{ ...nonPassed, lifecycleExcludedCaseIds: [] }} />);
      expect(screen.queryByTestId("gate-lifecycle-excluded")).toBeNull();
    });

    it("names the empty-set reason on a no_gating_cases gate (SATCA-FR-011)", () => {
      render(
        <GateStatePanel
          gate={{
            gateId: "WU-099",
            status: "no_gating_cases",
            unresolvedCaseIds: [],
            gatingCaseIds: [],
            coveringUnitIds: [],
            emptyReason: "lifecycle",
            lifecycleExcludedCaseIds: ["TC-001"],
            blockedBy: [],
            signedOff: false,
          }}
        />,
      );
      expect(screen.getByText(/excluded by lifecycle\./i)).toBeTruthy();
      expect(screen.queryByText(/level and type policy/)).toBeNull();
    });

    it("distinguishes a policy-emptied set from a lifecycle-emptied one", () => {
      render(
        <GateStatePanel
          gate={{
            gateId: "WU-099",
            status: "no_gating_cases",
            unresolvedCaseIds: [],
            gatingCaseIds: [],
            coveringUnitIds: [],
            emptyReason: "policy",
            lifecycleExcludedCaseIds: [],
            blockedBy: [],
            signedOff: false,
          }}
        />,
      );
      expect(screen.getByText(/level and type policy/)).toBeTruthy();
      expect(screen.queryByTestId("gate-lifecycle-excluded")).toBeNull();
    });

    it("has no axe violations with the exclusion line rendered", async () => {
      const { container } = render(<GateStatePanel gate={released} />);
      expectNoAxeFindings(await axe(container));
    });
  });

  it("has no axe violations", async () => {
    const { container } = render(<GateStatePanel gate={nonPassed} />);
    expectNoAxeFindings(await axe(container));
  });
});
