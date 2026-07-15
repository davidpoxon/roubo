// @vitest-environment jsdom
//
// #702 (FR-001/FR-012, AC1, TC-020/TC-026): the overview lists one card per gate
// with its status; a blocked (non-passed) card names its blocking unit and that
// line is absent once the gate passes (the evaluator clears coveringUnitIds on
// pass). Opening a card invokes onOpenGate. axe-clean.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import { renderWithProviders } from "../../test/renderWithProviders";
import GatesOverview from "./GatesOverview";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}
expect.extend({ toHaveNoViolations });

vi.mock("../../lib/api");
import * as api from "../../lib/api";
const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

// fetchGates now resolves the GatesResponse shape ({ gates, invalidSpecs }) rather
// than a bare gate array (#371). Wrap the gate arrays these cases assert on; the
// invalid-spec cases pass their own `invalidSpecs`.
function gatesData(gates: unknown[], invalidSpecs: unknown[] = []) {
  return { gates, invalidSpecs };
}

const blockedGate = {
  gateId: "WU-099",
  status: "failed" as const,
  unresolvedCaseIds: ["TC-001"],
  coveringUnitIds: ["WU-010"],
};

const passedGate = {
  gateId: "WU-099",
  status: "passed" as const,
  unresolvedCaseIds: [],
  coveringUnitIds: [],
};

// A gate carrying a phase (milestone) and a full gating set, so the card can title
// by phase and show the gating-case count (#433).
const phasedGate = {
  gateId: "WU-300",
  status: "pending" as const,
  milestone: "Phase 2: Routes",
  unresolvedCaseIds: ["TC-5"],
  gatingCaseIds: ["TC-5", "TC-6", "TC-7"],
  coveringUnitIds: ["WU-40"],
  blockedBy: [],
  signedOff: false,
};

// A downstream phase blocked by an upstream verify gate (#433, FR-001).
const upstreamBlockedGate = {
  gateId: "WU-400",
  status: "pending" as const,
  milestone: "Phase 3: UI",
  unresolvedCaseIds: ["TC-9"],
  gatingCaseIds: ["TC-9"],
  coveringUnitIds: ["WU-50"],
  blockedBy: ["WU-300"],
  signedOff: false,
};

describe("GatesOverview", () => {
  it("lists one card per gate with its status (AC1)", async () => {
    mockedApi.fetchGates.mockResolvedValue(
      gatesData([
        blockedGate,
        {
          gateId: "WU-200",
          status: "pending",
          unresolvedCaseIds: ["TC-9"],
          coveringUnitIds: ["WU-20"],
        },
      ]) as never,
    );
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("WU-099")).toBeTruthy());
    const cards = screen.getAllByTestId("gate-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("lists the gate's covering units under a Covers label, not a mislabeled Blocked by (#433)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([blockedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Covers/)).toBeTruthy());
    expect(screen.getByText("WU-010")).toBeTruthy();
    // The covers line is no longer mislabeled as an upstream blocker; a gate with
    // no upstream blockedBy shows no "Blocked by" line (#433).
    expect(screen.queryByText(/Blocked by/)).toBeNull();
  });

  it("titles the card by phase (milestone) with the gate id as a sub-label (#433)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([phasedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Phase 2: Routes")).toBeTruthy());
    // The gate id remains visible as a mono sub-label alongside the phase title.
    expect(screen.getByText("WU-300")).toBeTruthy();
  });

  it("falls back to the gate id as the title when the gate has no milestone (#433)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([blockedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("gate-title").textContent).toBe("WU-099"));
  });

  it("shows the gating-case count from gatingCaseIds (#433)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([phasedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("gate-gating-count")).toBeTruthy());
    expect(screen.getByTestId("gate-gating-count").textContent).toBe("3 gating cases");
  });

  it("shows an upstream Blocked by line naming the blocking gate (#433, FR-001)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([upstreamBlockedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("gate-blocked-by")).toBeTruthy());
    expect(screen.getByTestId("gate-blocked-by").textContent).toMatch(/Blocked by/);
    expect(within(screen.getByTestId("gate-blocked-by")).getByText("WU-300")).toBeTruthy();
    // The card carries the blocked visual treatment while an upstream blocks it.
    expect(screen.getByTestId("gate-card").dataset.blocked).toBe("true");
  });

  it("removes the upstream Blocked by line once the upstream gate clears (#433, AC2)", async () => {
    // Same phase, now with an empty blockedBy (its upstream gate was signed off).
    const cleared = { ...upstreamBlockedGate, blockedBy: [] };
    mockedApi.fetchGates.mockResolvedValue(gatesData([cleared]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Phase 3: UI")).toBeTruthy());
    expect(screen.queryByTestId("gate-blocked-by")).toBeNull();
    expect(screen.getByTestId("gate-card").dataset.blocked).toBeUndefined();
  });

  it("clears the blocking line once the gate passes (AC1)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([passedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Passed")).toBeTruthy());
    expect(screen.queryByText(/Blocked by/)).toBeNull();
  });

  it("invokes onOpenGate with the gate id when the card body is activated (AC1)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([blockedGate]) as never);
    const onOpen = vi.fn();
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={onOpen} />);
    await waitFor(() => expect(screen.getByTestId("gate-card")).toBeTruthy());
    // The whole-card open trigger is the absolute overlay Button (#804); it
    // covers the card body and the decorative chevron alike.
    fireEvent.click(screen.getByTestId("gate-open"));
    expect(onOpen).toHaveBeenCalledWith("WU-099");
  });

  it("opens the split dialog from the Split control without opening the gate (AC2)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([bigPhase]) as never);
    const onOpen = vi.fn();
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={onOpen} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("gate-split-trigger"));
    await waitFor(() => expect(screen.getByTestId("split-confirm")).toBeTruthy());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("toggles selection from the merge checkbox without opening the gate (AC3)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([phase2, phase3]) as never);
    const onOpen = vi.fn();
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={onOpen} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("merge-mode-trigger"));
    const checkbox = within(screen.getAllByTestId("gate-merge-checkbox")[0]).getByRole("checkbox");
    fireEvent.click(checkbox);
    // Selection reflected on the card; the gate did not open.
    await waitFor(() =>
      expect(screen.getAllByTestId("gate-card")[0].dataset.selected).toBe("true"),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("toggles selection (not open) when the card overlay is activated in merge mode", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([phase2, phase3]) as never);
    const onOpen = vi.fn();
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={onOpen} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());
    fireEvent.click(screen.getByTestId("merge-mode-trigger"));
    fireEvent.click(screen.getAllByTestId("gate-open")[0]);
    await waitFor(() =>
      expect(screen.getAllByTestId("gate-card")[0].dataset.selected).toBe("true"),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shows an empty-state message when there are no gates and no invalid specs (AC3)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no verify gates yet/)).toBeTruthy());
    // A genuinely-empty project shows no invalid-specs warning (#371).
    expect(screen.queryByTestId("invalid-specs-warning")).toBeNull();
  });

  // #549: the list is scoped to the bench's focused spec. The slug is threaded to
  // fetchGates so the server returns only that spec's gates (not every spec's).
  it("fetches gates scoped to the focused spec slug (#549)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([blockedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="brigade" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("WU-099")).toBeTruthy());
    expect(mockedApi.fetchGates).toHaveBeenCalledWith("p1", "brigade");
  });

  // #549: with no focused spec there is nothing to scope to, so the overview shows a
  // "focus a spec" empty state and never fetches the project-wide gates (the leak).
  it("shows a focus-a-spec empty state and does not fetch when no spec is focused (#549)", async () => {
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Focus a spec to see its batches/)).toBeTruthy());
    expect(mockedApi.fetchGates).not.toHaveBeenCalled();
  });

  // #371 (AC1): a present-but-invalid spec must surface a warning naming the slug +
  // its validation failure, not the bare "no verify gates yet" empty state, even
  // when every gate was dropped because the only spec failed validation.
  it("warns about an invalid spec instead of the empty state when all gates were dropped", async () => {
    mockedApi.fetchGates.mockResolvedValue(
      gatesData(
        [],
        [{ slug: "verify-gate", errors: ['work-units.json for spec "verify-gate" failed R4'] }],
      ) as never,
    );
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("invalid-specs-warning")).toBeTruthy());
    const warning = screen.getByTestId("invalid-specs-warning");
    expect(within(warning).getByText("verify-gate")).toBeTruthy();
    expect(within(warning).getByText(/failed R4/)).toBeTruthy();
    // The empty state must NOT show when a spec is broken.
    expect(screen.queryByText(/no verify gates yet/)).toBeNull();
  });

  // #371 (AC1 + #328 resilience): valid gates still render AND the broken spec is
  // surfaced as a warning alongside them.
  it("renders valid gates and still warns about an invalid spec", async () => {
    mockedApi.fetchGates.mockResolvedValue(
      gatesData([blockedGate], [{ slug: "verify-gate", errors: ["empty gating set"] }]) as never,
    );
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("WU-099")).toBeTruthy());
    expect(screen.getByTestId("gate-card")).toBeTruthy();
    const warning = screen.getByTestId("invalid-specs-warning");
    expect(within(warning).getByText("verify-gate")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([blockedGate]) as never);
    const { container } = renderWithProviders(
      <GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />,
    );
    await waitFor(() => expect(screen.getByTestId("gate-card")).toBeTruthy());
    expect(await axe(container)).toHaveNoViolations();
  });
});

// Two pending gates ready to merge (TC-022).
const phase2 = {
  gateId: "PHASE-2",
  status: "pending" as const,
  unresolvedCaseIds: ["TC-019"],
  coveringUnitIds: ["WU-031", "WU-032"],
};
const phase3 = {
  gateId: "PHASE-3",
  status: "pending" as const,
  unresolvedCaseIds: ["TC-030"],
  coveringUnitIds: ["WU-050"],
};

describe("GatesOverview - operator merge (TC-022)", () => {
  it("merges two selected gates and replaces them with the combined card (S001-O01)", async () => {
    mockedApi.fetchGates
      .mockResolvedValueOnce(gatesData([phase2, phase3]) as never)
      .mockResolvedValue(
        gatesData([
          {
            gateId: "MERGED:PHASE-2+PHASE-3",
            status: "pending",
            unresolvedCaseIds: ["TC-019"],
            coveringUnitIds: ["WU-031", "WU-032", "WU-050"],
          },
        ]) as never,
      );
    mockedApi.mergeGates.mockResolvedValue([] as never);

    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("merge-mode-trigger"));
    const checkboxes = screen.getAllByTestId("gate-merge-checkbox");
    fireEvent.click(within(checkboxes[0]).getByRole("checkbox"));
    fireEvent.click(within(checkboxes[1]).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("merge-confirm"));

    await waitFor(() =>
      expect(mockedApi.mergeGates).toHaveBeenCalledWith("p1", ["PHASE-2", "PHASE-3"]),
    );
    await waitFor(() => expect(screen.getByText("MERGED:PHASE-2+PHASE-3")).toBeTruthy());
    expect(screen.queryByText("PHASE-2")).toBeNull();
  });

  it("surfaces the 409 guard message when an involved gate is signed off (AC3)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([phase2, phase3]) as never);
    mockedApi.mergeGates.mockRejectedValue(
      new Error("Gate 'PHASE-2' is signed off (passed) and cannot be merged"),
    );

    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("merge-mode-trigger"));
    const checkboxes = screen.getAllByTestId("gate-merge-checkbox");
    fireEvent.click(within(checkboxes[0]).getByRole("checkbox"));
    fireEvent.click(within(checkboxes[1]).getByRole("checkbox"));
    fireEvent.click(screen.getByTestId("merge-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("overview-error").textContent).toMatch(/signed off/i),
    );
  });
});

const bigPhase = {
  gateId: "PHASE-2",
  status: "pending" as const,
  unresolvedCaseIds: ["TC-019", "TC-020", "TC-024", "TC-025"],
  coveringUnitIds: ["WU-031", "WU-032", "WU-033", "WU-034"],
};

describe("GatesOverview - operator split (TC-023)", () => {
  it("splits a gate by assigning covering units to two parts (S001-O01/O02)", async () => {
    mockedApi.fetchGates.mockResolvedValueOnce(gatesData([bigPhase]) as never).mockResolvedValue(
      gatesData([
        {
          gateId: "SPLIT:PHASE-2:A",
          status: "pending",
          unresolvedCaseIds: ["TC-019"],
          coveringUnitIds: ["WU-031", "WU-032"],
        },
        {
          gateId: "SPLIT:PHASE-2:B",
          status: "pending",
          unresolvedCaseIds: ["TC-024"],
          coveringUnitIds: ["WU-033", "WU-034"],
        },
      ]) as never,
    );
    mockedApi.splitGate.mockResolvedValue([] as never);

    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("gate-split-trigger"));
    // Default seed already partitions A/B; confirm directly.
    await waitFor(() => expect(screen.getByTestId("split-confirm")).toBeTruthy());
    fireEvent.click(screen.getByTestId("split-confirm"));

    await waitFor(() =>
      expect(mockedApi.splitGate).toHaveBeenCalledWith("p1", "PHASE-2", [
        { label: "A", coversWorkUnitIds: ["WU-031", "WU-032"] },
        { label: "B", coversWorkUnitIds: ["WU-033", "WU-034"] },
      ]),
    );
    await waitFor(() => expect(screen.getByText("SPLIT:PHASE-2:A")).toBeTruthy());
    expect(screen.getByText("SPLIT:PHASE-2:B")).toBeTruthy();
  });

  it("disables confirm when a part would be empty (no loss / two signable gates)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([bigPhase]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("gate-split-trigger"));
    await waitFor(() => expect(screen.getByTestId("split-confirm")).toBeTruthy());
    // Move every unit to A: part B empty, confirm disabled.
    for (const wu of bigPhase.coveringUnitIds) {
      fireEvent.click(screen.getByTestId(`split-assign-${wu}-A`));
    }
    expect((screen.getByTestId("split-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not offer a split control on a passed gate (AC3)", async () => {
    mockedApi.fetchGates.mockResolvedValue(gatesData([passedGate]) as never);
    renderWithProviders(<GatesOverview projectId="p1" specSlug="alpha" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Passed")).toBeTruthy());
    expect(screen.queryByTestId("gate-split-trigger")).toBeNull();
  });
});
