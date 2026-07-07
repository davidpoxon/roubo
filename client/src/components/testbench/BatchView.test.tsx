// @vitest-environment jsdom
//
// #702 (FR-008, AC2/AC3): the batch view fetches the plan filtered to the gate's
// gating subset, elides a phase with no gating cases with a clear label (not an
// unlabelled empty card), and guards sign-off (the action is disabled whenever the
// gate's evaluated status is not `passed`).
//
// #830 (FR-007/FR-008, AC5/AC6): sign-off is now a real, persisted server action.
// The button's state is sourced from the SERVER (`gate.signedOff`), not local
// React state, so a signed-off batch reads back as signed off (the button shows
// "Reopen") after navigating away and back. A signed-off gate can be reopened.

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

function planWithCase(filteredToGateIds: string[]) {
  // The ?gateIds= subset uses the gate's RAW declared ids, so an all-L3/L4 gate
  // still returns a case row here (the #436 batch-view half of the bug).
  return {
    plan: {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "demo",
      cases: [
        {
          id: "TC-L3",
          title: "An L3 case",
          area: "demo",
          level: 3,
          type: "functional",
          steps: [],
          tags: [],
          linked_requirement_ids: ["FR-001"],
          linked_user_story_ids: [],
        },
      ],
    },
    results: null,
    stale: false,
    planHash: "h",
    recovered: false,
    filteredToGateIds,
  };
}

function gateState(overrides: Record<string, unknown>) {
  return {
    gateId: "WU-099",
    status: "pending",
    unresolvedCaseIds: [],
    coveringUnitIds: [],
    signedOff: false,
    ...overrides,
  };
}

describe("BatchView", () => {
  it("fetches the plan filtered to the gate's gating subset (AC2)", async () => {
    mockedApi.fetchGate.mockResolvedValue(
      gateState({
        status: "pending",
        unresolvedCaseIds: ["TC-1"],
        coveringUnitIds: ["WU-10"],
      }) as never,
    );
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await waitFor(() =>
      expect(mockedApi.fetchTestbenchPlan).toHaveBeenCalledWith("p1", 3, ["WU-099"]),
    );
  });

  it("elides a phase with no gating cases with a clear label, not an empty card (AC2)", async () => {
    mockedApi.fetchGate.mockResolvedValue(gateState({ status: "passed" }) as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/no gating cases/i)).toBeTruthy());
  });

  it("elides on a no_gating_cases gate even when the subset plan still has case rows (#436)", async () => {
    // The gate narrows to empty (all L3/L4), so the server reports no_gating_cases,
    // but the ?gateIds= subset still returns the raw L3 case row. The notice must
    // fire off the gate status, and the L3 case must NOT render as a case row.
    mockedApi.fetchGate.mockResolvedValue(gateState({ status: "no_gating_cases" }) as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(planWithCase(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    // Both the gate-state panel and the case-list elision notice surface the
    // "no gating cases in scope" message for a no_gating_cases gate.
    const notices = await screen.findAllByText(/no gating cases in scope/i);
    expect(notices.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("An L3 case")).toBeNull();
  });

  it("disables 'Sign off batch' when the gate has not passed (AC3)", async () => {
    mockedApi.fetchGate.mockResolvedValue(
      gateState({
        status: "failed",
        unresolvedCaseIds: ["TC-1"],
        coveringUnitIds: ["WU-10"],
      }) as never,
    );
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await screen.findByText("Failed");
    const signOff = screen.getByRole("button", { name: "Sign off batch" });
    expect(signOff.getAttribute("data-disabled")).not.toBeNull();
    // Even if fired (stale UI), no server call is made for a non-passed gate.
    fireEvent.click(signOff);
    expect(mockedApi.signOffGate).not.toHaveBeenCalled();
  });

  it("enables 'Sign off batch' for a passed, not-signed-off gate (AC5)", async () => {
    mockedApi.fetchGate.mockResolvedValue(
      gateState({ status: "passed", signedOff: false }) as never,
    );
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await screen.findByText(/no gating cases/i);
    const signOff = screen.getByRole("button", { name: "Sign off batch" });
    expect(signOff.getAttribute("data-disabled")).toBeNull();
  });

  it("signs off via the server and re-reads 'Reopen' from server state, not local state (AC5)", async () => {
    // First read: passed, not signed off. After the mutation invalidates, the
    // gate re-reads as signed off, so the button must toggle from server state.
    mockedApi.fetchGate
      .mockResolvedValueOnce(gateState({ status: "passed", signedOff: false }) as never)
      .mockResolvedValue(gateState({ status: "passed", signedOff: true }) as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);
    mockedApi.signOffGate.mockResolvedValue(
      gateState({ status: "passed", signedOff: true }) as never,
    );

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    // Wait for both queries to resolve so the sign-off button is enabled (a
    // disabled React Aria button ignores onPress).
    await screen.findByText(/no gating cases/i);
    const signOff = screen.getByRole("button", { name: "Sign off batch" });
    expect(signOff.getAttribute("data-disabled")).toBeNull();
    fireEvent.click(signOff);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reopen" })).toBeTruthy());
    expect(mockedApi.signOffGate).toHaveBeenCalledWith("p1", "WU-099");
  });

  it("shows 'Reopen' (server-sourced, persists across navigation) for a signed-off gate and reopens (AC5/AC6)", async () => {
    mockedApi.fetchGate.mockResolvedValue(
      gateState({ status: "passed", signedOff: true }) as never,
    );
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);
    mockedApi.reopenGate.mockResolvedValue(
      gateState({ status: "passed", signedOff: false }) as never,
    );

    // A fresh render (e.g. after navigating away and back) re-reads the server
    // gate: signedOff is true, so the button shows "Reopen" with no local state.
    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    const reopen = await screen.findByRole("button", { name: "Reopen" });
    expect(reopen.getAttribute("data-disabled")).toBeNull();
    fireEvent.click(reopen);
    await waitFor(() => expect(mockedApi.reopenGate).toHaveBeenCalledWith("p1", "WU-099"));
  });

  it("surfaces a clear error when sign-off fails (NFR-005, loud degrade)", async () => {
    mockedApi.fetchGate.mockResolvedValue(
      gateState({ status: "passed", signedOff: false }) as never,
    );
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);
    mockedApi.signOffGate.mockRejectedValue(
      new Error("Gate 'WU-099' has no tracker issue, so it cannot be signed off."),
    );

    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={() => {}} />);
    await screen.findByText(/no gating cases/i);
    const signOff = screen.getByRole("button", { name: "Sign off batch" });
    fireEvent.click(signOff);
    await screen.findByText(/no tracker issue/);
  });

  it("invokes onBack from the back action", async () => {
    mockedApi.fetchGate.mockResolvedValue(gateState({ status: "passed" }) as never);
    mockedApi.fetchTestbenchPlan.mockResolvedValue(emptyPlan(["WU-099"]) as never);
    const onBack = vi.fn();
    renderWithProviders(<BatchView projectId="p1" benchId={3} gateId="WU-099" onBack={onBack} />);
    const back = await screen.findByRole("button", { name: /Back to batches/ });
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });
});
