// @vitest-environment jsdom
//
// #702 (FR-001/FR-012, AC1, TC-020/TC-026): the overview lists one card per gate
// with its status; a blocked (non-passed) card names its blocking unit and that
// line is absent once the gate passes (the evaluator clears coveringUnitIds on
// pass). Opening a card invokes onOpenGate. axe-clean.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("GatesOverview", () => {
  it("lists one card per gate with its status (AC1)", async () => {
    mockedApi.fetchGates.mockResolvedValue([
      blockedGate,
      {
        gateId: "WU-200",
        status: "pending",
        unresolvedCaseIds: ["TC-9"],
        coveringUnitIds: ["WU-20"],
      },
    ] as never);
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("WU-099")).toBeTruthy());
    const cards = screen.getAllByTestId("gate-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("names the blocking unit on a blocked card (AC1)", async () => {
    mockedApi.fetchGates.mockResolvedValue([blockedGate] as never);
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Blocked by/)).toBeTruthy());
    expect(screen.getByText("WU-010")).toBeTruthy();
  });

  it("clears the blocking line once the gate passes (AC1)", async () => {
    mockedApi.fetchGates.mockResolvedValue([passedGate] as never);
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Passed")).toBeTruthy());
    expect(screen.queryByText(/Blocked by/)).toBeNull();
  });

  it("invokes onOpenGate with the gate id when a card is activated", async () => {
    mockedApi.fetchGates.mockResolvedValue([blockedGate] as never);
    const onOpen = vi.fn();
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={onOpen} />);
    await waitFor(() => expect(screen.getByTestId("gate-card")).toBeTruthy());
    fireEvent.click(screen.getByTestId("gate-open"));
    expect(onOpen).toHaveBeenCalledWith("WU-099");
  });

  it("shows an empty-state message when there are no gates", async () => {
    mockedApi.fetchGates.mockResolvedValue([] as never);
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no verify gates yet/)).toBeTruthy());
  });

  it("has no axe violations", async () => {
    mockedApi.fetchGates.mockResolvedValue([blockedGate] as never);
    const { container } = renderWithProviders(
      <GatesOverview projectId="p1" onOpenGate={() => {}} />,
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
    mockedApi.fetchGates.mockResolvedValueOnce([phase2, phase3] as never).mockResolvedValue([
      {
        gateId: "MERGED:PHASE-2+PHASE-3",
        status: "pending",
        unresolvedCaseIds: ["TC-019"],
        coveringUnitIds: ["WU-031", "WU-032", "WU-050"],
      },
    ] as never);
    mockedApi.mergeGates.mockResolvedValue([] as never);

    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("merge-mode-trigger"));
    const checkboxes = screen.getAllByTestId("gate-merge-checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByTestId("merge-confirm"));

    await waitFor(() =>
      expect(mockedApi.mergeGates).toHaveBeenCalledWith("p1", ["PHASE-2", "PHASE-3"]),
    );
    await waitFor(() => expect(screen.getByText("MERGED:PHASE-2+PHASE-3")).toBeTruthy());
    expect(screen.queryByText("PHASE-2")).toBeNull();
  });

  it("surfaces the 409 guard message when an involved gate is signed off (AC3)", async () => {
    mockedApi.fetchGates.mockResolvedValue([phase2, phase3] as never);
    mockedApi.mergeGates.mockRejectedValue(
      new Error("Gate 'PHASE-2' is signed off (passed) and cannot be merged"),
    );

    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("PHASE-2")).toBeTruthy());

    fireEvent.click(screen.getByTestId("merge-mode-trigger"));
    const checkboxes = screen.getAllByTestId("gate-merge-checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
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
    mockedApi.fetchGates.mockResolvedValueOnce([bigPhase] as never).mockResolvedValue([
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
    ] as never);
    mockedApi.splitGate.mockResolvedValue([] as never);

    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
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
    mockedApi.fetchGates.mockResolvedValue([bigPhase] as never);
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
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
    mockedApi.fetchGates.mockResolvedValue([passedGate] as never);
    renderWithProviders(<GatesOverview projectId="p1" onOpenGate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Passed")).toBeTruthy());
    expect(screen.queryByTestId("gate-split-trigger")).toBeNull();
  });
});
