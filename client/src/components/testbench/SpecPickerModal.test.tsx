// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/renderWithProviders";
import type {
  DiscoveredSpec,
  InvalidSpec,
  SpecLifecycleState,
  SpecVerification,
} from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";

// Lifecycle defaults to live (no record on disk); archived fixtures state only
// the fields they need (#770).
function lifecycle(over: Partial<SpecLifecycleState> = {}): SpecLifecycleState {
  return { archived: false, reason: null, supersededBy: null, recordError: null, ...over };
}

// Build a verification payload with sensible defaults; each fixture states only
// the fields it needs (#482/#483).
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
// #773: the lifecycle write is the only network call the picker makes itself
// (the rest go through the mocked hooks above), so stub it at the api boundary
// and keep the real useSpecLifecycleMutation, whose cache invalidation is part
// of what these tests exercise.
const mockSetSpecLifecycle = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    setSpecLifecycle: (...args: unknown[]) => mockSetSpecLifecycle(...args),
  };
});

// Mock only the two data-fetching hooks; keep the real pure helpers
// (partitionSpecs / deriveSpecSummary), which SpecPickerModal imports from the
// same module and which need no mocking.
vi.mock("../../hooks/useTestbenchSpecs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useTestbenchSpecs")>();
  return {
    ...actual,
    useTestbenchSpecs: (...args: unknown[]) => mockUseTestbenchSpecs(...args),
    useManualPathValidation: (...args: unknown[]) => mockUseManualPathValidation(...args),
  };
});

import SpecPickerModal from "./SpecPickerModal";

const SPECS: DiscoveredSpec[] = [
  // Needs-attention: some passed, some in-progress -> "1 of 3 passed".
  {
    slug: "testbench",
    path: "/repo/.specifications/testbench/test-cases.json",
    caseCount: 3,
    verification: verification({ statusCounts: { passed: 1, in_progress: 2 } }),
    lifecycle: lifecycle(),
  },
  // Needs-attention with a failure -> "0 of 1 passed" + "· 1 failed".
  {
    slug: "billing",
    path: "/repo/.specifications/billing/test-cases.json",
    caseCount: 1,
    verification: verification({ statusCounts: { failed: 1 } }),
    lifecycle: lifecycle(),
  },
  // All-passed: relegated to the collapsed tail disclosure.
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

// #770: one merely-archived spec and one recorded as superseded, added to the
// live fixtures above for the archival suite.
const ARCHIVED: DiscoveredSpec = {
  slug: "retired-flow",
  path: "/repo/.specifications/retired-flow/test-cases.json",
  caseCount: 4,
  verification: verification({ statusCounts: { passed: 2, not_started: 2 } }),
  lifecycle: lifecycle({ archived: true, reason: "Shipped in #212" }),
};

const SUPERSEDED: DiscoveredSpec = {
  slug: "billing-v1",
  path: "/repo/.specifications/billing-v1/test-cases.json",
  caseCount: 2,
  verification: verification({ classification: "all-passed", statusCounts: { passed: 2 } }),
  lifecycle: lifecycle({ archived: true, supersededBy: "billing-v2" }),
};

const SPECS_WITH_ARCHIVED: DiscoveredSpec[] = [...SPECS, ARCHIVED, SUPERSEDED];

function specsQuery(over: Partial<ReturnType<typeof mockUseTestbenchSpecs>> = {}) {
  return {
    data: { specs: SPECS, invalid: [] },
    isLoading: false,
    isError: false,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTestbenchSpecs.mockReturnValue(specsQuery());
  mockUseManualPathValidation.mockReturnValue({ status: "idle" } satisfies ManualPathState);
  mockSetSpecLifecycle.mockResolvedValue({
    archived: true,
    reason: null,
    supersededBy: null,
    recordError: null,
  });
});

function renderModal(props: Partial<React.ComponentProps<typeof SpecPickerModal>> = {}) {
  return renderWithProviders(
    <SpecPickerModal isOpen onClose={vi.fn()} projectId="p1" onCreate={vi.fn()} {...props} />,
  );
}

describe("SpecPickerModal", () => {
  it("lists discovered specs with slug, path, and case count", () => {
    renderModal();
    expect(screen.getByText("testbench")).toBeInTheDocument();
    expect(screen.getByText("/repo/.specifications/testbench/test-cases.json")).toBeInTheDocument();
    expect(screen.getByText("3 cases")).toBeInTheDocument();
    expect(screen.getByText("1 case")).toBeInTheDocument();
  });

  it("shows the empty discovery state when no specs are found", () => {
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: { specs: [], invalid: [] } }));
    renderModal();
    expect(screen.getByText("No specs found in this project.")).toBeInTheDocument();
  });

  it("surfaces present-but-invalid specs with their errors instead of the empty state", () => {
    const invalid: InvalidSpec[] = [
      {
        slug: "broken",
        path: "/repo/.specifications/broken/test-cases.json",
        errors: ["cases.0.level: Invalid input: expected number, received string"],
      },
    ];
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: { specs: [], invalid } }));
    renderModal();
    expect(screen.queryByText("No specs found in this project.")).not.toBeInTheDocument();
    expect(
      screen.getByText("1 spec file does not match the schema and was skipped:"),
    ).toBeInTheDocument();
    expect(screen.getByText("broken")).toBeInTheDocument();
    expect(
      screen.getByText("cases.0.level: Invalid input: expected number, received string"),
    ).toBeInTheDocument();
  });

  it("shows a loading state while discovering", () => {
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: undefined, isLoading: true }));
    renderModal();
    expect(screen.getByText("Discovering specs...")).toBeInTheDocument();
  });

  it("surfaces a discovery error", () => {
    mockUseTestbenchSpecs.mockReturnValue(
      specsQuery({ data: undefined, isError: true, error: new Error("boom") }),
    );
    renderModal();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("disables Create until a spec is selected", async () => {
    renderModal();
    const create = screen.getByRole("button", { name: /Create TestBench/ });
    expect(create).toBeDisabled();
    await userEvent.click(screen.getByText("testbench"));
    expect(create).not.toBeDisabled();
  });

  it("calls onCreate with the focused spec path on confirm", async () => {
    const onCreate = vi.fn();
    renderModal({ onCreate });
    await userEvent.click(screen.getByText("billing"));
    await userEvent.click(screen.getByRole("button", { name: /Create TestBench/ }));
    expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/billing/test-cases.json");
  });

  it("renders the manual-path validating state", () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "validating",
    } satisfies ManualPathState);
    renderModal();
    expect(screen.getByText("Validating...")).toBeInTheDocument();
  });

  it("renders the manual-path valid state and enables Create", () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "valid",
      slug: "manual",
      caseCount: 2,
      path: "/repo/.specifications/manual/test-cases.json",
    } satisfies ManualPathState);
    renderModal();
    expect(screen.getByText(/Valid: manual \(2 cases\)/)).toBeInTheDocument();
  });

  it("renders the manual-path invalid state with an actionable message", () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "invalid",
      errors: ["path escapes the project repository"],
    } satisfies ManualPathState);
    renderModal();
    expect(screen.getByText("path escapes the project repository")).toBeInTheDocument();
  });

  it("binds the manual path to onCreate once it validates", async () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "valid",
      slug: "manual",
      caseCount: 2,
      path: "/repo/.specifications/manual/test-cases.json",
    } satisfies ManualPathState);
    const onCreate = vi.fn();
    renderModal({ onCreate });
    // Type into the manual field so the manual selection takes precedence.
    await userEvent.type(
      screen.getByLabelText("Or enter a path"),
      "/repo/.specifications/manual/test-cases.json",
    );
    await userEvent.click(screen.getByRole("button", { name: /Create TestBench/ }));
    expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/manual/test-cases.json");
  });

  it("is keyboard operable: select a spec and confirm without the mouse", async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderModal({ onCreate });
    // Focus the first spec toggle and select it with the keyboard.
    const firstSpec = screen.getByText("testbench").closest("button") as HTMLElement;
    await act(async () => {
      firstSpec.focus();
    });
    await user.keyboard("{Enter}");
    const create = screen.getByRole("button", { name: /Create TestBench/ });
    await waitFor(() => expect(create).not.toBeDisabled());
    await act(async () => {
      create.focus();
    });
    await user.keyboard("{Enter}");
    expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/testbench/test-cases.json");
  });

  it("shows the creating label while a create is in flight", () => {
    renderModal({ isCreating: true });
    expect(screen.getByRole("button", { name: "Creating..." })).toBeInTheDocument();
  });

  describe("partitioned picker (#483)", () => {
    it("lists only needs-attention specs in the main space, all-passed behind the collapsed disclosure", () => {
      renderModal();
      // Needs-attention specs are in the main space.
      expect(screen.getByText("testbench")).toBeInTheDocument();
      expect(screen.getByText("billing")).toBeInTheDocument();
      // All-passed specs are hidden until the disclosure is expanded.
      expect(screen.queryByText("shipped-alpha")).not.toBeInTheDocument();
      expect(screen.queryByText("shipped-beta")).not.toBeInTheDocument();
      // A collapsed disclosure row at the tail names the count.
      const disclosure = screen.getByRole("button", { name: /All passed/ });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText("· 2 specs")).toBeInTheDocument();
    });

    it("renders a pass-state summary per needs-attention spec (dot/icon plus text, never colour alone)", () => {
      renderModal();
      // Progress summary for a partially-passed spec.
      expect(screen.getByText("1 of 3 passed")).toBeInTheDocument();
      // Failure fragment for a spec with failed cases.
      expect(screen.getByText("0 of 1 passed")).toBeInTheDocument();
      expect(screen.getByText("· 1 failed")).toBeInTheDocument();
    });

    it("renders the 'no results yet' summary when a spec has no sidecar", () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({
          data: {
            specs: [
              {
                slug: "fresh",
                path: "/repo/.specifications/fresh/test-cases.json",
                caseCount: 4,
                verification: verification({
                  resultsPresent: false,
                  resultsValid: false,
                  planHashMatch: false,
                  statusCounts: { not_started: 4 },
                }),
                lifecycle: lifecycle(),
              },
            ],
            invalid: [],
          },
        }),
      );
      renderModal();
      expect(screen.getByText("no results yet")).toBeInTheDocument();
    });

    it("renders the 'results stale' summary when a valid sidecar mismatches the plan hash", () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({
          data: {
            specs: [
              {
                slug: "moved-on",
                path: "/repo/.specifications/moved-on/test-cases.json",
                caseCount: 29,
                verification: verification({
                  resultsPresent: true,
                  resultsValid: true,
                  planHashMatch: false,
                  statusCounts: { passed: 29 },
                }),
                lifecycle: lifecycle(),
              },
            ],
            invalid: [],
          },
        }),
      );
      renderModal();
      expect(screen.getByText("results stale")).toBeInTheDocument();
    });

    it("reveals de-emphasized all-passed rows on expand and shows their 'All M passed' summary", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      const alpha = screen.getByText("shipped-alpha");
      expect(alpha).toBeInTheDocument();
      // De-emphasized via colour hierarchy: the slug drops to muted stone (never
      // the full-strength stone-800 a needs-attention slug uses). It holds the
      // per-theme AA floor in both themes: text-stone-500 on white, dark:text-stone-400
      // on the stone-900 modal (#493).
      expect(alpha).toHaveClass("text-stone-500");
      expect(alpha).toHaveClass("dark:text-stone-400");
      expect(screen.getByText("testbench")).toHaveClass("text-stone-800");
      // Each all-passed row carries its own pass-state summary.
      expect(screen.getByText("All 5 passed")).toBeInTheDocument();
      expect(screen.getByText("All 8 passed")).toBeInTheDocument();
    });

    it("collapses the all-passed disclosure again after the modal is dismissed", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      expect(screen.getByText("shipped-alpha")).toBeInTheDocument();
      // Dismiss resets the disclosure to collapsed (so it is collapsed on reopen).
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByText("shipped-alpha")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /All passed/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });

    it("keeps exactly one selection across the needs-attention and all-passed groups", async () => {
      const onCreate = vi.fn();
      renderModal({ onCreate });
      // Select a needs-attention row, then an all-passed row inside the disclosure.
      await userEvent.click(screen.getByText("testbench"));
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      await userEvent.click(screen.getByText("shipped-beta"));
      // Exactly one row is selected across both groups.
      expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
      // Confirm binds the last (all-passed) selection.
      await userEvent.click(screen.getByRole("button", { name: /Create TestBench/ }));
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/shipped-beta/test-cases.json");
    });
  });

  describe("re-point mode (#423)", () => {
    it("uses the re-point title, helper text, and confirm label", () => {
      renderModal({ mode: "repoint" });
      expect(screen.getByText("Change focused spec")).toBeInTheDocument();
      expect(screen.getByText(/Re-point this TestBench/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Re-point TestBench/ })).toBeInTheDocument();
      // The create copy must not leak into re-point mode.
      expect(screen.queryByText("Create a TestBench")).not.toBeInTheDocument();
    });

    it("shows the re-pointing busy label while a re-point is in flight", () => {
      renderModal({ mode: "repoint", isCreating: true });
      expect(screen.getByRole("button", { name: "Re-pointing..." })).toBeInTheDocument();
    });

    it("confirms a re-point with the chosen spec path", async () => {
      const onCreate = vi.fn();
      renderModal({ mode: "repoint", onCreate });
      await userEvent.click(screen.getByText("billing"));
      await userEvent.click(screen.getByRole("button", { name: /Re-point TestBench/ }));
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/billing/test-cases.json");
    });

    it("flags the currently focused spec row as Active (#444, TC-007 step 2)", () => {
      renderModal({
        mode: "repoint",
        activePath: "/repo/.specifications/testbench/test-cases.json",
      });
      const badge = screen.getByText("Active");
      expect(badge).toBeInTheDocument();
      // The badge sits on the active spec's row, not the other discovered spec.
      const activeRow = screen
        .getByText("/repo/.specifications/testbench/test-cases.json")
        .closest("button") as HTMLElement;
      const otherRow = screen
        .getByText("/repo/.specifications/billing/test-cases.json")
        .closest("button") as HTMLElement;
      expect(activeRow).toContainElement(badge);
      expect(otherRow).not.toContainElement(badge);
    });

    it("does not render an Active badge in create mode even when an activePath is passed", () => {
      renderModal({
        mode: "create",
        activePath: "/repo/.specifications/testbench/test-cases.json",
      });
      expect(screen.queryByText("Active")).not.toBeInTheDocument();
    });

    it("dismissing via Cancel leaves the focused spec unchanged (no onCreate, explicit only)", async () => {
      const onCreate = vi.fn();
      const onClose = vi.fn();
      renderModal({ mode: "repoint", onCreate, onClose });
      // Pick a spec but then cancel instead of confirming.
      await userEvent.click(screen.getByText("billing"));
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCreate).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });

    it("renders the identical partitioned view and supports cross-group single selection", async () => {
      const onCreate = vi.fn();
      renderModal({ mode: "repoint", onCreate });
      // Same partition: needs-attention in the main space, all-passed collapsed.
      expect(screen.getByText("testbench")).toBeInTheDocument();
      expect(screen.queryByText("shipped-alpha")).not.toBeInTheDocument();
      await userEvent.click(screen.getByText("billing"));
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      await userEvent.click(screen.getByText("shipped-alpha"));
      expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
      await userEvent.click(screen.getByRole("button", { name: /Re-point TestBench/ }));
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/shipped-alpha/test-cases.json");
    });
  });

  describe("all-passed empty state (#484)", () => {
    // Every discovered spec is all-passed: the main space would otherwise be
    // blank, so the picker shows the explicit empty state.
    const ALL_PASSED_ONLY = SPECS.filter((s) => s.verification.classification === "all-passed");

    it("shows the empty-state heading and body when every discovered spec is all-passed", () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal();
      expect(
        screen.getByText("Every discovered spec has all test cases passed"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Browse the completed specs below, or point a TestBench at a test-cases.json by hand.",
        ),
      ).toBeInTheDocument();
    });

    it("places the collapsed all-passed disclosure beneath the empty state (AC1)", () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal();
      const message = screen.getByText("Every discovered spec has all test cases passed");
      const disclosure = screen.getByRole("button", { name: /All passed/ });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByText("· 2 specs")).toBeInTheDocument();
      // The empty-state message precedes the disclosure in the document.
      expect(
        message.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("does not show the empty state for a mixed needs-attention/all-passed list", () => {
      renderModal();
      expect(
        screen.queryByText("Every discovered spec has all test cases passed"),
      ).not.toBeInTheDocument();
    });

    it("keeps the empty state when invalid specs are also present (separate messaging)", () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({
          data: {
            specs: ALL_PASSED_ONLY,
            invalid: [
              {
                slug: "broken",
                path: "/repo/.specifications/broken/test-cases.json",
                errors: ["cases.0.level: Invalid input: expected number, received string"],
              },
            ],
          },
        }),
      );
      renderModal();
      // The empty state does not depend on hasInvalid; both surfaces coexist.
      expect(
        screen.getByText("Every discovered spec has all test cases passed"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("1 spec file does not match the schema and was skipped:"),
      ).toBeInTheDocument();
    });

    it("disclosure is keyboard operable: Enter and Space both flip aria-expanded (AC3)", async () => {
      const user = userEvent.setup();
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal();
      const disclosure = screen.getByRole("button", { name: /All passed/ });
      await act(async () => {
        disclosure.focus();
      });
      expect(disclosure).toHaveFocus();
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      // Enter toggles open, then closed.
      await user.keyboard("{Enter}");
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await user.keyboard("{Enter}");
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      // Space also toggles it.
      await user.keyboard("[Space]");
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
    });

    it("disclosure shows a visible focus ring under keyboard focus (AC3)", async () => {
      const user = userEvent.setup();
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal();
      const disclosure = screen.getByRole("button", { name: /All passed/ });
      // Tab through the modal (keyboard modality) until the disclosure is focused.
      for (let i = 0; i < 6 && document.activeElement !== disclosure; i++) {
        await user.tab();
      }
      expect(disclosure).toHaveFocus();
      // React Aria applies the amber focus ring only under keyboard focus-visible.
      await waitFor(() => expect(disclosure.className).toContain("ring-amber-500"));
    });

    it("a revealed all-passed row is keyboard-selectable and enables confirm (AC3)", async () => {
      const user = userEvent.setup();
      const onCreate = vi.fn();
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal({ onCreate });
      // Expand the disclosure with the keyboard.
      const disclosure = screen.getByRole("button", { name: /All passed/ });
      await act(async () => {
        disclosure.focus();
      });
      await user.keyboard("{Enter}");
      // Focus a revealed all-passed row and select it with the keyboard.
      const row = screen.getByText("shipped-alpha").closest("button") as HTMLElement;
      await act(async () => {
        row.focus();
      });
      await user.keyboard("{Enter}");
      const create = screen.getByRole("button", { name: /Create TestBench/ });
      await waitFor(() => expect(create).not.toBeDisabled());
      await act(async () => {
        create.focus();
      });
      await user.keyboard("{Enter}");
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/shipped-alpha/test-cases.json");
    });

    it("manual-path escape hatch still validates and binds in the empty state (AC2)", async () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      mockUseManualPathValidation.mockReturnValue({
        status: "valid",
        slug: "manual",
        caseCount: 2,
        path: "/repo/.specifications/manual/test-cases.json",
      } satisfies ManualPathState);
      const onCreate = vi.fn();
      renderModal({ onCreate });
      // The empty state does not disable the manual escape hatch.
      expect(screen.getByText(/Valid: manual \(2 cases\)/)).toBeInTheDocument();
      await userEvent.type(
        screen.getByLabelText("Or enter a path"),
        "/repo/.specifications/manual/test-cases.json",
      );
      await userEvent.click(screen.getByRole("button", { name: /Create TestBench/ }));
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/manual/test-cases.json");
    });

    it("de-emphasized all-passed rows keep the per-theme AA text floor (AC4)", async () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      const slug = screen.getByText("shipped-alpha");
      // The muted slug and path hold the per-theme AA text floor in BOTH themes:
      // text-stone-500 (4.8:1 on white) and dark:text-stone-400 (6.8:1 on the
      // stone-900 modal). Dark-theme jsdom cannot execute the axe color-contrast
      // rule, so the real-rendering check lives in the Playwright spec
      // e2e/e2e-flow/spec-picker-contrast.spec.ts (#493).
      expect(slug).toHaveClass("text-stone-500");
      expect(slug).toHaveClass("dark:text-stone-400");
      const path = screen.getByText("/repo/.specifications/shipped-alpha/test-cases.json");
      expect(path).toHaveClass("text-stone-500");
      expect(path).toHaveClass("dark:text-stone-400");
    });
  });

  describe("archived specs (#770, SATCA-FR-015/FR-016)", () => {
    beforeEach(() => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: SPECS_WITH_ARCHIVED, invalid: [] } }),
      );
    });

    // SATCA-TC-035 / AC1.
    it("hides archived specs from the default list, in neither live group", async () => {
      renderModal();
      expect(screen.queryByText("retired-flow")).not.toBeInTheDocument();
      expect(screen.queryByText("billing-v1")).not.toBeInTheDocument();
      // Live specs are listed as before: needs-attention up front, all-passed
      // behind its own disclosure. Expanding that disclosure must not surface an
      // archived spec either, even the all-passed one.
      expect(screen.getByText("testbench")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      expect(screen.getByText("shipped-alpha")).toBeInTheDocument();
      expect(screen.queryByText("billing-v1")).not.toBeInTheDocument();
    });

    it("counts the archived specs on its reveal control, collapsed by default", () => {
      renderModal();
      const control = screen.getByRole("button", { name: /Show archived/ });
      expect(control).toHaveAttribute("aria-pressed", "false");
      expect(control).toHaveAttribute("aria-expanded", "false");
      // Scoped to the control: the all-passed disclosure also counts two specs.
      expect(within(control).getByText("· 2 specs")).toBeInTheDocument();
    });

    it("renders no reveal control when nothing is archived", () => {
      mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: { specs: SPECS, invalid: [] } }));
      renderModal();
      expect(screen.queryByRole("button", { name: /Show archived/ })).not.toBeInTheDocument();
    });

    // SATCA-TC-036 / AC2.
    it("reveals the archived specs alongside the live ones, labelled in text", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      expect(screen.getByRole("button", { name: /Show archived/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const group = screen.getByRole("group", { name: "Archived specs" });
      expect(within(group).getByText("retired-flow")).toBeInTheDocument();
      // The label is words, not colour alone.
      expect(within(group).getByText("Archived")).toBeInTheDocument();
      expect(within(group).getByText("Shipped in #212")).toBeInTheDocument();
      // The live specs stay listed.
      expect(screen.getByText("testbench")).toBeInTheDocument();
      expect(screen.getByText("billing")).toBeInTheDocument();
    });

    // SATCA-TC-037 / AC3.
    it("labels a superseded spec distinctly and names the spec that replaced it", async () => {
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      const supersededRow = screen
        .getByText("/repo/.specifications/billing-v1/test-cases.json")
        .closest("button") as HTMLElement;
      expect(within(supersededRow).getByText("Superseded")).toBeInTheDocument();
      expect(within(supersededRow).queryByText("Archived")).not.toBeInTheDocument();
      expect(within(supersededRow).getByText("billing-v2")).toBeInTheDocument();
      // The merely-archived row is labelled the other way round.
      const archivedRow = screen
        .getByText("/repo/.specifications/retired-flow/test-cases.json")
        .closest("button") as HTMLElement;
      expect(within(archivedRow).getByText("Archived")).toBeInTheDocument();
      expect(within(archivedRow).queryByText("Superseded")).not.toBeInTheDocument();
    });

    // SATCA-TC-038 / AC4 (client half): a revealed archived spec is still a
    // selectable row in the one controlled group, so it can be loaded.
    it("keeps a revealed archived spec selectable and loadable", async () => {
      const onCreate = vi.fn();
      renderModal({ onCreate });
      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      await userEvent.click(screen.getByText("retired-flow"));
      expect(screen.getAllByRole("radio", { checked: true })).toHaveLength(1);
      const create = screen.getByRole("button", { name: /Create TestBench/ });
      expect(create).not.toBeDisabled();
      await userEvent.click(create);
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/retired-flow/test-cases.json");
    });

    // Dismissal resets the reveal (reset() runs on Cancel / overlay / Escape), so
    // the picker always reopens with archived specs hidden again.
    it("re-collapses the archived group on dismissal", async () => {
      const onClose = vi.fn();
      renderModal({ onClose });
      await userEvent.click(screen.getByRole("button", { name: /Show archived/ }));
      expect(screen.getByText("retired-flow")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onClose).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByText("retired-flow")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: /Show archived/ })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });

    it("does not claim every spec passed when the only hidden specs are archived", () => {
      // Live needs-attention specs remain, so the all-passed empty state (which
      // keys on the LIVE groups) must stay away.
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: [SPECS[0], ARCHIVED], invalid: [] } }),
      );
      renderModal();
      expect(
        screen.queryByText("Every discovered spec has all test cases passed"),
      ).not.toBeInTheDocument();
    });

    it("does not show the all-passed empty state for an archived-only project", () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: [ARCHIVED, SUPERSEDED], invalid: [] } }),
      );
      renderModal();
      expect(
        screen.queryByText("Every discovered spec has all test cases passed"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Show archived/ })).toBeInTheDocument();
    });
  });

  // #773, SATCA-FR-020/FR-021/FR-028, SATCA-TC-047/050.
  describe("spec lifecycle actions (#773)", () => {
    beforeEach(() => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: SPECS_WITH_ARCHIVED, invalid: [] } }),
      );
    });

    async function openMenu(user: ReturnType<typeof userEvent.setup>, slug: string) {
      await user.click(screen.getByRole("button", { name: `Actions for ${slug}` }));
      return screen.getByRole("menu");
    }

    it("offers Archive and Supersede on a live row, and Restore on an archived one", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: /Show archived/ }));

      const liveMenu = await openMenu(user, "testbench");
      expect(within(liveMenu).getByRole("menuitem", { name: /Archive/ })).toBeInTheDocument();
      expect(within(liveMenu).getByRole("menuitem", { name: /Supersede/ })).toBeInTheDocument();
      expect(within(liveMenu).queryByRole("menuitem", { name: /Restore/ })).not.toBeInTheDocument();
      await user.keyboard("{Escape}");

      const archivedMenu = await openMenu(user, "retired-flow");
      expect(within(archivedMenu).getByRole("menuitem", { name: /Restore/ })).toBeInTheDocument();
      expect(
        within(archivedMenu).queryByRole("menuitem", { name: /^Archive/ }),
      ).not.toBeInTheDocument();
    });

    it("keeps the actions menu OUT of the selectable row, so the two never nest", () => {
      renderModal();
      const row = screen.getByRole("radio", { name: /^testbench/ });
      expect(
        within(row).queryByRole("button", { name: "Actions for testbench" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Actions for testbench" })).toBeInTheDocument();
    });

    it("archives a spec with an optional reason and names the manifest it writes", async () => {
      const user = userEvent.setup();
      renderModal();

      await openMenu(user, "testbench");
      await user.click(screen.getByRole("menuitem", { name: /Archive/ }));

      expect(screen.getByText("Archive this specification")).toBeInTheDocument();
      expect(
        screen.getByText(".specifications/testbench/manifest.json", { exact: false }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Left uncommitted for you to review/)).toBeInTheDocument();

      await user.type(screen.getByLabelText("Reason (optional)"), "Shipped in #212");
      await user.click(screen.getByRole("button", { name: "Archive" }));

      await waitFor(() =>
        expect(mockSetSpecLifecycle).toHaveBeenCalledWith("p1", "testbench", {
          archived: true,
          reason: "Shipped in #212",
        }),
      );
      // The confirm step closes and the picker list returns.
      await waitFor(() =>
        expect(screen.queryByText("Archive this specification")).not.toBeInTheDocument(),
      );
    });

    it("omits an empty reason rather than recording a blank string", async () => {
      const user = userEvent.setup();
      renderModal();

      await openMenu(user, "testbench");
      await user.click(screen.getByRole("menuitem", { name: /Archive/ }));
      await user.type(screen.getByLabelText("Reason (optional)"), "   ");
      await user.click(screen.getByRole("button", { name: "Archive" }));

      await waitFor(() =>
        expect(mockSetSpecLifecycle).toHaveBeenCalledWith("p1", "testbench", { archived: true }),
      );
    });

    it("supersedes from a selector over the project's OTHER specs, never free text", async () => {
      const user = userEvent.setup();
      renderModal();

      await openMenu(user, "testbench");
      await user.click(screen.getByRole("menuitem", { name: /Supersede/ }));

      expect(screen.getByText("Supersede this specification")).toBeInTheDocument();
      // Nothing to type into: the target is chosen, not entered.
      expect(screen.queryByRole("textbox", { name: /Superseded by/ })).not.toBeInTheDocument();
      // Confirm stays disabled until a target is chosen.
      expect(screen.getByRole("button", { name: "Supersede" })).toBeDisabled();

      await user.click(screen.getByRole("button", { name: /Choose a specification/ }));
      const options = screen.getAllByRole("option").map((o) => o.textContent);
      expect(options).toContain("billing");
      // The spec being superseded is excluded from its own target list.
      expect(options).not.toContain("testbench");

      await user.click(screen.getByRole("option", { name: "billing" }));
      await user.click(screen.getByRole("button", { name: "Supersede" }));

      await waitFor(() =>
        expect(mockSetSpecLifecycle).toHaveBeenCalledWith("p1", "testbench", {
          archived: true,
          supersededBy: "billing",
        }),
      );
    });

    it("restores an archived spec by clearing the record, with no confirm step", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: /Show archived/ }));

      await openMenu(user, "retired-flow");
      await user.click(screen.getByRole("menuitem", { name: /Restore/ }));

      await waitFor(() =>
        expect(mockSetSpecLifecycle).toHaveBeenCalledWith("p1", "retired-flow", null),
      );
    });

    it("reverses a supersession through the same Restore action", async () => {
      const user = userEvent.setup();
      renderModal();
      await user.click(screen.getByRole("button", { name: /Show archived/ }));

      await openMenu(user, "billing-v1");
      await user.click(screen.getByRole("menuitem", { name: /Restore/ }));

      await waitFor(() =>
        expect(mockSetSpecLifecycle).toHaveBeenCalledWith("p1", "billing-v1", null),
      );
    });

    it("surfaces a refused write without dismissing the confirm step", async () => {
      mockSetSpecLifecycle.mockRejectedValue(new Error("manifest.json is not valid JSON"));
      const user = userEvent.setup();
      renderModal();

      await openMenu(user, "testbench");
      await user.click(screen.getByRole("menuitem", { name: /Archive/ }));
      await user.click(screen.getByRole("button", { name: "Archive" }));

      expect(await screen.findByText("manifest.json is not valid JSON")).toBeInTheDocument();
      expect(screen.getByText("Archive this specification")).toBeInTheDocument();
    });

    it("abandons the confirm step on Cancel without writing anything", async () => {
      const user = userEvent.setup();
      renderModal();

      await openMenu(user, "testbench");
      await user.click(screen.getByRole("menuitem", { name: /Archive/ }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.queryByText("Archive this specification")).not.toBeInTheDocument();
      expect(screen.getByText("Discovered specs")).toBeInTheDocument();
      expect(mockSetSpecLifecycle).not.toHaveBeenCalled();
    });
  });
});
