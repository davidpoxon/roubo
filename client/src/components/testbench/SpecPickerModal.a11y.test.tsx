// @vitest-environment jsdom
//
// #484 TSPF-NFR-003 / TSPF-TC-015: the partitioned spec picker reports zero axe
// violations in BOTH modes (create + repoint) and BOTH partition states (a mixed
// needs-attention/all-passed list and the all-passed-only empty state), including
// the expanded all-passed disclosure. Follows the vitest-axe wiring established by
// CaseList.a11y.test.tsx and the hook-mock setup from SpecPickerModal.test.tsx.
//
// Coverage gap (#493): jsdom has no layout/paint engine, so axe cannot execute the
// color-contrast rule here (it silently reports zero contrast violations even when
// text fails WCAG AA in a real browser). Real-rendering color-contrast is therefore
// verified separately in the Playwright spec e2e/e2e-flow/spec-picker-contrast.spec.ts,
// which injects axe-core into Chromium and runs the color-contrast rule across both
// themes, both modes, and both partition states.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { DiscoveredSpec, SpecVerification } from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}
expect.extend({ toHaveNoViolations });

// Build a verification payload with sensible defaults; each fixture states only
// the fields it needs (mirrors SpecPickerModal.test.tsx).
function verification(
  over: Partial<Omit<SpecVerification, "statusCounts">> & {
    statusCounts?: Partial<SpecVerification["statusCounts"]>;
  } = {},
): SpecVerification {
  const { statusCounts, ...rest } = over;
  return {
    classification: "needs-attention",
    resultsPresent: true,
    resultsValid: true,
    planHashMatch: true,
    recoveryReason: null,
    aggregationError: false,
    ...rest,
    statusCounts: {
      not_started: 0,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      ...(statusCounts ?? {}),
    },
  };
}

const mockUseTestbenchSpecs = vi.hoisted(() => vi.fn());
const mockUseManualPathValidation = vi.hoisted(() => vi.fn());

// Mock only the two data-fetching hooks; keep the real pure helpers
// (partitionSpecs / deriveSpecSummary) the component imports from the same module.
vi.mock("../../hooks/useTestbenchSpecs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useTestbenchSpecs")>();
  return {
    ...actual,
    useTestbenchSpecs: (...args: unknown[]) => mockUseTestbenchSpecs(...args),
    useManualPathValidation: (...args: unknown[]) => mockUseManualPathValidation(...args),
  };
});

import SpecPickerModal from "./SpecPickerModal";

// A mixed list: needs-attention specs in the main space, all-passed behind the
// collapsed disclosure.
const MIXED: DiscoveredSpec[] = [
  {
    slug: "testbench",
    path: "/repo/.specifications/testbench/test-cases.json",
    caseCount: 3,
    verification: verification({ statusCounts: { passed: 1, in_progress: 2 } }),
  },
  {
    slug: "billing",
    path: "/repo/.specifications/billing/test-cases.json",
    caseCount: 1,
    verification: verification({ statusCounts: { failed: 1 } }),
  },
  {
    slug: "shipped-alpha",
    path: "/repo/.specifications/shipped-alpha/test-cases.json",
    caseCount: 5,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 5 } }),
  },
  {
    slug: "shipped-beta",
    path: "/repo/.specifications/shipped-beta/test-cases.json",
    caseCount: 8,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 8 } }),
  },
];

// Every discovered spec is all-passed: the picker renders the empty state above
// the collapsed disclosure.
const ALL_PASSED: DiscoveredSpec[] = [
  {
    slug: "shipped-alpha",
    path: "/repo/.specifications/shipped-alpha/test-cases.json",
    caseCount: 5,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 5 } }),
  },
  {
    slug: "shipped-beta",
    path: "/repo/.specifications/shipped-beta/test-cases.json",
    caseCount: 8,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 8 } }),
  },
];

function specsQuery(specs: DiscoveredSpec[]) {
  return {
    data: { specs, invalid: [] },
    isLoading: false,
    isError: false,
    error: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTestbenchSpecs.mockReturnValue(specsQuery(MIXED));
  mockUseManualPathValidation.mockReturnValue({ status: "idle" } satisfies ManualPathState);
});

function renderModal(props: Partial<React.ComponentProps<typeof SpecPickerModal>> = {}) {
  return renderWithProviders(
    <SpecPickerModal isOpen onClose={vi.fn()} projectId="p1" onCreate={vi.fn()} {...props} />,
  );
}

// Scope the scan to the modal itself (screen.getByRole("dialog")) so page-level
// best-practice rules (a missing h1, landmark regions) do not muddy the result:
// we are auditing the picker component, not a whole page.
async function expectNoViolations() {
  const results = await axe(screen.getByRole("dialog"));
  expect(results).toHaveNoViolations();
}

describe("SpecPickerModal a11y (#484)", () => {
  describe("create mode", () => {
    it("has no axe violations for a mixed needs-attention/all-passed list", async () => {
      renderModal();
      await expectNoViolations();
    });

    it("has no axe violations with the all-passed disclosure expanded", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      expect(screen.getByText("shipped-alpha")).toBeInTheDocument();
      await expectNoViolations();
    });

    it("has no axe violations for the all-passed-only empty state", async () => {
      mockUseTestbenchSpecs.mockReturnValue(specsQuery(ALL_PASSED));
      renderModal();
      expect(
        screen.getByText("Every discovered spec has all test cases passed"),
      ).toBeInTheDocument();
      await expectNoViolations();
    });

    it("has no axe violations for the empty state with the disclosure expanded", async () => {
      mockUseTestbenchSpecs.mockReturnValue(specsQuery(ALL_PASSED));
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      expect(screen.getByText("shipped-alpha")).toBeInTheDocument();
      await expectNoViolations();
    });
  });

  describe("repoint mode", () => {
    it("has no axe violations for a mixed list", async () => {
      renderModal({
        mode: "repoint",
        activePath: "/repo/.specifications/testbench/test-cases.json",
      });
      await expectNoViolations();
    });

    it("has no axe violations for the all-passed-only empty state", async () => {
      mockUseTestbenchSpecs.mockReturnValue(specsQuery(ALL_PASSED));
      renderModal({ mode: "repoint" });
      expect(
        screen.getByText("Every discovered spec has all test cases passed"),
      ).toBeInTheDocument();
      await expectNoViolations();
    });
  });
});
