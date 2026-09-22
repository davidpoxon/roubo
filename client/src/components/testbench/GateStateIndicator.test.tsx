// @vitest-environment jsdom
//
// #726 (VG-NFR-004): every gate status renders a visible text label (never colour
// alone) plus a decorative dot, across the full GateStatus set.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GateStatus } from "../../lib/api";
import GateStateIndicator from "./GateStateIndicator";

const CASES: { status: GateStatus; label: string }[] = [
  { status: "passed", label: "Passed" },
  { status: "failed", label: "Failed" },
  { status: "pending", label: "Pending" },
  { status: "stale", label: "Stale" },
  { status: "no_gating_cases", label: "No gating cases" },
];

describe("GateStateIndicator", () => {
  for (const { status, label } of CASES) {
    it(`renders a text label for the ${status} status`, () => {
      const { container } = render(<GateStateIndicator status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      const dot = container.querySelector('[aria-hidden="true"]');
      expect(dot).toBeTruthy();
    });
  }

  // #912: no_gating_cases is not a pass, so it must use the neutral text-body
  // role, never the passed success roles.
  it("renders no_gating_cases with a neutral (non-success) token", () => {
    const { container } = render(<GateStateIndicator status="no_gating_cases" />);
    const label = screen.getByText("No gating cases");
    expect(label.className).toContain("text-text-body");
    expect(label.className).not.toContain("success");
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot?.className).toContain("bg-text-body");
    expect(dot?.className).not.toContain("status-active");
  });
});
