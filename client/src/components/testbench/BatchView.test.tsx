// @vitest-environment jsdom
//
// #702 (FR-008, AC2/AC3, TC-028): the batch view fetches the plan filtered to the
// gate's gating subset, elides a phase with no gating cases with a clear label
// (not an unlabelled empty card), and guards sign-off: the action is rejected
// (and disabled) whenever the gate's evaluated status is not `passed`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../../test/renderWithProviders";
import BatchView from "./BatchView";

vi.mock("../../lib/api");
import * as api from "../../lib/api";
const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.resetAllMocks();
});

function emptyPlan(filteredToGateIds: string[]) {
  return {
    plan: { $schema: "x", schemaVersion: "1.0.0", specSlug: "demo", cases: [] },
    results: null,
    stale: false,
    planHash: "h",
    recovered: false,
    filteredToGateIds,
  };
}

describe("BatchView", () => {
  it("fetches the plan filtered to the gate's gating subset (AC2)", async () => {
    mockedApi.fetchGate.mockResolvedValue({
      gateId: "WU-099",
      status: "pending",
      unresolvedCaseIds: ["TC-1"],
      coveringUnitIds: ["WU-10"],
    } as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await waitFor(() =>
      expect(mockedApi.fetchTestbenchPlan).toHaveBeenCalledWith("p1", 3, ["WU-099"]),
    );
  });

  it("elides a phase with no gating cases with a clear label, not an empty card (AC2)", async () => {
    mockedApi.fetchGate.mockResolvedValue({
      gateId: "WU-099",
      status: "passed",
      unresolvedCaseIds: [],
      coveringUnitIds: [],
    } as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no gating cases/)).toBeTruthy());
  });

  it("rejects sign-off when the gate has not passed (AC3)", async () => {
    mockedApi.fetchGate.mockResolvedValue({
      gateId: "WU-099",
      status: "failed",
      unresolvedCaseIds: ["TC-1"],
      coveringUnitIds: ["WU-10"],
    } as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    // Wait for the gate state to load before asserting on the guard.
    await screen.findByText("Failed");
    const signOff = screen.getByRole("button", { name: "Sign off batch" });
    // The guard disables the action when the gate is not passed.
    expect(signOff.getAttribute("data-disabled")).not.toBeNull();
    // Even if invoked (stale UI), the rejection is the load-bearing guard.
    fireEvent.click(signOff);
    expect(screen.queryByText("Signed off")).toBeNull();
  });

  it("allows sign-off when the gate has passed (AC3)", async () => {
    mockedApi.fetchGate.mockResolvedValue({
      gateId: "WU-099",
      status: "passed",
      unresolvedCaseIds: [],
      coveringUnitIds: [],
    } as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    // Wait for the gate to load (the elided-batch notice only renders once both
    // queries resolve), so the sign-off guard sees the passed status.
    await screen.findByText(/no gating cases/);
    const signOff = screen.getByRole("button", { name: "Sign off batch" });
    expect(signOff.getAttribute("data-disabled")).toBeNull();
    fireEvent.click(signOff);
    await waitFor(() => expect(screen.getByText("Signed off")).toBeTruthy());
  });

  it("invokes onBack from the back action", async () => {
    mockedApi.fetchGate.mockResolvedValue({
      gateId: "WU-099",
      status: "passed",
      unresolvedCaseIds: [],
      coveringUnitIds: [],
    } as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);
    const onBack = vi.fn();
    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={onBack} />);
    const back = await screen.findByRole("button", { name: /Back to batches/ });
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });
});
