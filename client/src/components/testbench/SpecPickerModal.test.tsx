// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { DiscoveredSpec, InvalidSpec, SpecVerification } from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";

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
  },
  // Needs-attention with a failure -> "0 of 1 passed" + "· 1 failed".
  {
    slug: "billing",
    path: "/repo/.specifications/billing/test-cases.json",
    caseCount: 1,
    verification: verification({ statusCounts: { failed: 1 } }),
  },
  // All-passed: relegated to the collapsed tail disclosure.
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
      // the full-strength stone-800 a needs-attention slug uses).
      expect(alpha).toHaveClass("text-stone-500");
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

    it("de-emphasized all-passed rows keep the stone-500 AA text floor (AC4)", async () => {
      mockUseTestbenchSpecs.mockReturnValue(
        specsQuery({ data: { specs: ALL_PASSED_ONLY, invalid: [] } }),
      );
      renderModal();
      await userEvent.click(screen.getByRole("button", { name: /All passed/ }));
      const slug = screen.getByText("shipped-alpha");
      // The muted slug never drops below stone-500, the AA text floor on white
      // recorded in roubo/DESIGN.md.
      expect(slug).toHaveClass("text-stone-500");
      const path = screen.getByText("/repo/.specifications/shipped-alpha/test-cases.json");
      expect(path).toHaveClass("text-stone-500");
    });
  });
});
