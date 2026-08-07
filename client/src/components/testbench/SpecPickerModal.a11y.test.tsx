// @vitest-environment jsdom
//
// #484 TSPF-NFR-003 / TSPF-TC-015: the partitioned spec picker reports zero axe
// violations in BOTH modes (create + repoint) and BOTH partition states (a mixed
// needs-attention/all-passed list and the all-passed-only empty state), including
// the expanded all-passed disclosure. Asserts through the shared expectNoAxeFindings
// helper (client/src/test/axe.ts) and the hook-mock setup from SpecPickerModal.test.tsx.
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
import { renderWithProviders } from "../../test/renderWithProviders";
import type { DiscoveredSpec, SpecLifecycleState, SpecVerification } from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";
import { expectNoAxeFindings } from "../../test/axe";

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

// Lifecycle defaults to live (no record on disk); the archived fixtures below
// state only the fields they need (#770).
function lifecycle(over: Partial<SpecLifecycleState> = {}): SpecLifecycleState {
  return { archived: false, reason: null, supersededBy: null, recordError: null, ...over };
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
    lifecycle: lifecycle(),
  },
  {
    slug: "billing",
    path: "/repo/.specifications/billing/test-cases.json",
    caseCount: 1,
    verification: verification({ statusCounts: { failed: 1 } }),
    lifecycle: lifecycle(),
  },
  {
    slug: "shipped-alpha",
    path: "/repo/.specifications/shipped-alpha/test-cases.json",
    caseCount: 5,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 5 } }),
    lifecycle: lifecycle(),
  },
  {
    slug: "shipped-beta",
    path: "/repo/.specifications/shipped-beta/test-cases.json",
    caseCount: 8,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 8 } }),
    lifecycle: lifecycle(),
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
    lifecycle: lifecycle(),
  },
  {
    slug: "shipped-beta",
    path: "/repo/.specifications/shipped-beta/test-cases.json",
    caseCount: 8,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 8 } }),
    lifecycle: lifecycle(),
  },
];

// #770: the mixed list plus one merely-archived and one superseded spec, both
// hidden until the reveal control is pressed.
const WITH_ARCHIVED: DiscoveredSpec[] = [
  ...MIXED,
  {
    slug: "retired-flow",
    path: "/repo/.specifications/retired-flow/test-cases.json",
    caseCount: 4,
    verification: verification({ statusCounts: { passed: 2, not_started: 2 } }),
    lifecycle: lifecycle({ archived: true, reason: "Shipped in #212" }),
  },
  {
    slug: "billing-v1",
    path: "/repo/.specifications/billing-v1/test-cases.json",
    caseCount: 2,
    verification: verification({ classification: "all-passed", statusCounts: { passed: 2 } }),
    lifecycle: lifecycle({ archived: true, supersededBy: "billing-v2" }),
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
  expectNoAxeFindings(results);
}

describe("SpecPickerModal a11y (#484)", () => {
  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

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

  // #770 (SATCA-FR-015/FR-016): the reveal control and the group it discloses.
  describe("archived reveal", () => {
    beforeEach(() => {
      mockUseTestbenchSpecs.mockReturnValue(specsQuery(WITH_ARCHIVED));
    });

    it("exposes the reveal control's pressed and expanded state", async () => {
      renderModal();
      const control = screen.getByRole("button", { name: /Show archived/ });
      expect(control).toHaveAttribute("aria-pressed", "false");
      expect(control).toHaveAttribute("aria-expanded", "false");
      await userEvent.click(control);
      expect(control).toHaveAttribute("aria-pressed", "true");
      expect(control).toHaveAttribute("aria-expanded", "true");
    });

    it("labels the revealed group so it is distinguishable from the live ones", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      expect(screen.getByRole("group", { name: "Archived specs" })).toBeInTheDocument();
    });

    // #775 AC2. aria-pressed says what the control is; aria-controls says what it
    // governs, so the group it discloses is reachable from the control itself.
    it("points the reveal control at the group it discloses", async () => {
      renderModal();
      const control = screen.getByRole("button", { name: /Show archived/ });
      await userEvent.click(control);
      const group = screen.getByRole("group", { name: "Archived specs" });
      expect(control.getAttribute("aria-controls")).toBe(group.id);
      expect(group.id).not.toBe("");
    });

    // #775 AC2: the resulting LIST change is announced, not just the control's
    // own pressed state. The region is mounted before the change so the update is
    // announced rather than being swallowed as initial content.
    it("announces the resulting list change in a polite live region", async () => {
      renderModal();
      const status = screen.getByTestId("archived-reveal-status");
      expect(status).toHaveAttribute("aria-live", "polite");
      expect(status).toHaveTextContent("Archived specs hidden");

      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      // WITH_ARCHIVED carries two archived specs.
      expect(status).toHaveTextContent("2 archived specs shown");

      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      expect(status).toHaveTextContent("Archived specs hidden");
    });

    it("is keyboard operable: Enter and Space both flip the reveal", async () => {
      const user = userEvent.setup();
      renderModal();
      const control = screen.getByRole("button", { name: /Show archived/ });
      control.focus();
      expect(control).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(control).toHaveAttribute("aria-pressed", "true");
      await user.keyboard("{Enter}");
      expect(control).toHaveAttribute("aria-pressed", "false");
      await user.keyboard("[Space]");
      expect(control).toHaveAttribute("aria-pressed", "true");
    });

    it("has no axe violations with archived specs hidden", async () => {
      renderModal();
      await expectNoViolations();
    });

    it("has no axe violations with archived specs revealed", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      expect(screen.getByText("retired-flow")).toBeInTheDocument();
      await expectNoViolations();
    });
  });

  // #773 (SATCA-FR-020/FR-021): the per-row actions menu and the confirm step
  // it opens. The row is a ToggleButton, so the trigger MUST be a sibling of it,
  // never a child: the axe scans below are what hold that line.
  describe("lifecycle actions menu", () => {
    beforeEach(() => {
      mockUseTestbenchSpecs.mockReturnValue(specsQuery(WITH_ARCHIVED));
    });

    it("names each row's trigger after the spec it acts on", () => {
      renderModal();
      expect(screen.getByRole("button", { name: "Actions for testbench" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Actions for billing" })).toBeInTheDocument();
    });

    it("does not nest the trigger inside the selectable row", () => {
      renderModal();
      const row = screen.getByRole("radio", { name: /^testbench/ });
      expect(row.querySelector("button")).toBeNull();
    });

    it("is keyboard operable: Enter opens the menu and lands on the first item", async () => {
      const user = userEvent.setup();
      renderModal();
      const trigger = screen.getByRole("button", { name: "Actions for testbench" });
      trigger.focus();
      await user.keyboard("{Enter}");
      const menu = await screen.findByRole("menu");
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      await user.keyboard("{ArrowDown}");
      expect(menu).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });

    it("has no axe violations with the actions menu open", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: "Actions for testbench" }));
      expect(await screen.findByRole("menu")).toBeInTheDocument();
      await expectNoViolations();
    });

    it("has no axe violations on the archive confirm step", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: "Actions for testbench" }));
      await user.click(await screen.findByRole("menuitem", { name: /Archive/ }));
      expect(screen.getByText("Archive this specification")).toBeInTheDocument();
      await expectNoViolations();
    });

    it("has no axe violations on the supersede confirm step", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: "Actions for testbench" }));
      await user.click(await screen.findByRole("menuitem", { name: /Supersede/ }));
      expect(screen.getByText("Supersede this specification")).toBeInTheDocument();
      await expectNoViolations();
    });

    it("has no axe violations with the archived rows and their Restore menus revealed", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: /Show archived/ }));
      await user.click(screen.getByRole("button", { name: "Actions for retired-flow" }));
      expect(await screen.findByRole("menuitem", { name: /Restore/ })).toBeInTheDocument();
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
