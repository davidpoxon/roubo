// @vitest-environment jsdom
//
// The Set up Spec Bench dialog's delivery line and attach note (SB-FR-003,
// SB-TC-007 step 2): an attach names the progress and lifecycle state of the
// committed delivery record, or says there is none, and says no session will be
// launched; a launch shows neither.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SpecBenchSpecSummary } from "@roubo/shared/delivery-bench";
import type { DiscoveredSpec } from "../../lib/api";

vi.mock("../../hooks/useTestbenchSpecs", () => ({ useTestbenchSpecs: vi.fn() }));
vi.mock("../../hooks/useSpecBenchSpecSummary", () => ({ useSpecBenchSpecSummary: vi.fn() }));

import { useTestbenchSpecs } from "../../hooks/useTestbenchSpecs";
import { useSpecBenchSpecSummary } from "../../hooks/useSpecBenchSpecSummary";
import SpecBenchSetupModal from "./SpecBenchSetupModal";

const SPEC = {
  slug: "fixture-spec",
  path: "/repos/demo/.specifications/fixture-spec/test-cases.json",
  lifecycle: { archived: false, reason: null, supersededBy: null, recordError: null },
} as unknown as DiscoveredSpec;

function useSummary(data: SpecBenchSpecSummary): void {
  vi.mocked(useSpecBenchSpecSummary).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
  } as unknown as ReturnType<typeof useSpecBenchSpecSummary>);
}

async function pick(mode: RegExp): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<SpecBenchSetupModal isOpen onClose={vi.fn()} projectId="demo" onConfirm={vi.fn()} />);
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("radio", { name: mode }));
  await user.click(within(dialog).getByText(SPEC.slug));
  return dialog;
}

beforeEach(() => {
  vi.mocked(useTestbenchSpecs).mockReturnValue({
    data: { specs: [SPEC], invalid: [] },
    isLoading: false,
    isError: false,
    isSuccess: true,
    error: null,
  } as unknown as ReturnType<typeof useTestbenchSpecs>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SpecBenchSetupModal delivery line", () => {
  it("SB-TC-007: an attach names the committed record's progress and lifecycle state", async () => {
    useSummary({
      slug: SPEC.slug,
      units: 4,
      gates: 2,
      delivery: { deliveryId: "d-1", lifecycleState: "running", unitsDone: 2, units: 4 },
    });
    const dialog = await pick(/^attach/i);
    expect(within(dialog).getByTestId("specbench-setup-summary-progress")).toHaveTextContent(
      /^2 of 4 units done$/,
    );
    expect(within(dialog).getByTestId("specbench-setup-summary-lifecycle")).toHaveTextContent(
      /^running$/,
    );
    expect(within(dialog).getByTestId("specbench-setup-attach-note")).toHaveTextContent(
      /no session will be launched/i,
    );
  });

  it("SB-TC-007: an attach with no committed record says so", async () => {
    useSummary({ slug: SPEC.slug, units: 4, gates: 2 });
    const dialog = await pick(/^attach/i);
    expect(within(dialog).getByTestId("specbench-setup-summary-delivery")).toHaveTextContent(
      /no committed delivery record for the bench to join/,
    );
    expect(within(dialog).queryByTestId("specbench-setup-summary-progress")).toBeNull();
  });

  it("SB-TC-007: a launch shows no delivery line and no attach note", async () => {
    useSummary({
      slug: SPEC.slug,
      units: 4,
      gates: 2,
      delivery: { deliveryId: "d-1", lifecycleState: "running", unitsDone: 2, units: 4 },
    });
    const dialog = await pick(/^launch/i);
    expect(within(dialog).getByTestId("specbench-setup-summary-mode")).toHaveTextContent(
      /^Launch$/,
    );
    expect(within(dialog).queryByTestId("specbench-setup-summary-delivery")).toBeNull();
    expect(within(dialog).queryByTestId("specbench-setup-attach-note")).toBeNull();
  });
});
