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
    fireEvent.click(screen.getByTestId("gate-card"));
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
