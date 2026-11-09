// @vitest-environment jsdom
//
// The Set up Spec Bench dialog (#1625): Launch a delivery and Attach to a
// record tabs over the Specification menu. The delivery line and attach note
// (SB-FR-003, SB-TC-007 step 2): an attach names the progress and lifecycle
// state of the committed delivery record, or says there is none, and says no
// session will be launched; a launch shows neither.
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
  caseCount: 12,
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

async function pick(mode: RegExp, onConfirm = vi.fn()): Promise<HTMLElement> {
  const user = userEvent.setup();
  render(<SpecBenchSetupModal isOpen onClose={vi.fn()} projectId="demo" onConfirm={onConfirm} />);
  const dialog = screen.getByRole("dialog");
  await user.click(within(dialog).getByRole("tab", { name: mode }));
  await user.click(within(dialog).getByRole("button", { name: /specification/i }));
  await user.click(await screen.findByRole("option", { name: /^fixture-spec · 12 cases$/ }));
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
    expect(within(dialog).getByRole("tab", { name: "Launch a delivery" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dialog).queryByTestId("specbench-setup-summary-delivery")).toBeNull();
    expect(within(dialog).queryByTestId("specbench-setup-attach-note")).toBeNull();
  });
});

describe("SpecBenchSetupModal tabs", () => {
  const summary: SpecBenchSpecSummary = {
    slug: SPEC.slug,
    units: 4,
    gates: 2,
    delivery: { deliveryId: "d-1", lifecycleState: "running", unitsDone: 2, units: 4 },
  };

  it("opens on Launch, with the Specification menu, the Decisions switch and the workspace line", () => {
    useSummary(summary);
    render(<SpecBenchSetupModal isOpen onClose={vi.fn()} projectId="demo" onConfirm={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const tabs = within(dialog).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Launch a delivery", "Attach to a record"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("button", { name: /specification/i })).toBeInTheDocument();
    expect(within(dialog).getByRole("radiogroup", { name: "Decisions" })).toBeInTheDocument();
    expect(within(dialog).getByTestId("specbench-setup-workspace")).toHaveTextContent(
      /assigned when the bench is created/,
    );
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("names the picked spec's folder and plan on Launch, and launches with the decision mode", async () => {
    useSummary(summary);
    const onConfirm = vi.fn();
    const dialog = await pick(/^launch/i, onConfirm);
    expect(dialog).toHaveTextContent("/repos/demo/.specifications/fixture-spec");
    expect(within(dialog).getByTestId("specbench-setup-summary")).toHaveTextContent(
      /^4 units · 2 gates$/,
    );
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("radio", { name: "Auto" }));
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(
      "/repos/demo/.specifications/fixture-spec",
      "launch",
      "auto",
    );
  });

  it("shows the record path and the found delivery on Attach, with no Decisions switch, and attaches", async () => {
    useSummary(summary);
    const onConfirm = vi.fn();
    const dialog = await pick(/^attach/i, onConfirm);
    expect(within(dialog).getByTestId("specbench-setup-record")).toHaveTextContent(
      "/repos/demo/.specifications/fixture-spec/delivery-observation.json",
    );
    expect(within(dialog).getByTestId("specbench-setup-summary-delivery")).toHaveTextContent(
      "Found delivery d-1 · 2 of 4 units done · running",
    );
    expect(within(dialog).queryByRole("radiogroup", { name: "Decisions" })).toBeNull();
    expect(within(dialog).queryByTestId("specbench-setup-workspace")).toBeNull();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledWith(
      "/repos/demo/.specifications/fixture-spec",
      "attach",
      "attended",
    );
  });

  it("enables Confirm once a spec is picked, with no tab pressed, and launches attended", async () => {
    useSummary(summary);
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(<SpecBenchSetupModal isOpen onClose={vi.fn()} projectId="demo" onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /specification/i }));
    await user.click(await screen.findByRole("option", { name: /^fixture-spec · 12 cases$/ }));
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(
      "/repos/demo/.specifications/fixture-spec",
      "launch",
      "attended",
    );
  });

  it("keeps the picked spec and the decision mode across the tabs", async () => {
    useSummary(summary);
    const dialog = await pick(/^launch/i);
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("radio", { name: "Auto" }));
    await user.click(within(dialog).getByRole("tab", { name: /^attach/i }));
    expect(within(dialog).getByTestId("specbench-setup-record")).toHaveTextContent(
      "/repos/demo/.specifications/fixture-spec/delivery-observation.json",
    );
    await user.click(within(dialog).getByRole("tab", { name: /^launch/i }));
    expect(within(dialog).getByRole("button", { name: /specification/i })).toHaveTextContent(
      "fixture-spec · 12 cases",
    );
    expect(within(dialog).getByRole("radio", { name: "Auto" })).toBeChecked();
  });
});
