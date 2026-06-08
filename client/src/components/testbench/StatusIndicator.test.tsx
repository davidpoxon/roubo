// @vitest-environment jsdom
//
// #419 NFR-004: every status renders a visible text label (never colour alone)
// plus a decorative dot, across the full CaseStatus set.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { CaseStatus } from "@roubo/shared/testbench-contracts";
import StatusIndicator from "./StatusIndicator";

const CASES: { status: CaseStatus; label: string }[] = [
  { status: "not_started", label: "Not started" },
  { status: "in_progress", label: "In progress" },
  { status: "passed", label: "Passed" },
  { status: "failed", label: "Failed" },
  { status: "blocked", label: "Blocked" },
];

describe("StatusIndicator", () => {
  for (const { status, label } of CASES) {
    it(`renders a text label for the ${status} status`, () => {
      const { container } = render(<StatusIndicator status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      // The colour dot is decorative and hidden from assistive tech.
      const dot = container.querySelector('[aria-hidden="true"]');
      expect(dot).toBeTruthy();
    });
  }
});
