// @vitest-environment jsdom
//
// #774 (SATCA-TC-073/074/075/076/077, SATCA-FR-028, SATCA-FR-029): the two-stage
// replacement picker. Stage one is a specification selector defaulting to the
// case's own spec; stage two is a filterable, area-grouped list of that spec's
// cases with the case being superseded excluded. Before anything is confirmed the
// picker previews how the chosen pointer would resolve, through the SAME shared
// LifecycleResolver the gate uses, and refuses to confirm any choice the resolver
// calls unresolvable.
//
// The candidate closure is mocked at the hook boundary (the route's own suite
// covers the closure walk); the resolver is deliberately NOT mocked, because the
// whole point of the slice is that the preview is the resolver's own answer.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReplacementPicker from "./ReplacementPicker";
import type { ReplacementCandidatesResponse } from "../../lib/api";

vi.mock("../../hooks/useReplacementCandidates", () => ({
  useReplacementCandidates: vi.fn(),
}));
import { useReplacementCandidates } from "../../hooks/useReplacementCandidates";

const mockCandidates = vi.mocked(useReplacementCandidates);

// A ten-hop chain of superseded cases. Following it from the origin lands on the
// tenth hop still superseded, which is exactly the state MAX_SUPERSESSION_DEPTH
// refuses: the eleventh hop is the one that is never taken.
const DEEP = Array.from({ length: 10 }, (_, i) => ({
  id: `TC-D${String(i + 1).padStart(2, "0")}`,
  title: `Deep chain hop ${i + 1}`,
  area: "deep",
  level: 2,
  lifecycle: {
    state: "superseded" as const,
    replacement: i === 9 ? "TC-002" : `TC-D${String(i + 2).padStart(2, "0")}`,
  },
}));

const SPECS = [
  { slug: "testbench", caseCount: 15, archived: false },
  { slug: "verify-gate", caseCount: 2, archived: false },
];

const TESTBENCH_PLAN = {
  specSlug: "testbench",
  cases: [
    // The origin. Present in the plan (the resolver needs the origin spec
    // supplied) but excluded from the offered list.
    { id: "TC-001", title: "The case being superseded", area: "reconcile", level: 1 },
    { id: "TC-002", title: "Live sibling case", area: "reconcile", level: 2 },
    {
      id: "TC-003",
      title: "Chained case",
      area: "staleness",
      level: 2,
      lifecycle: { state: "superseded" as const, replacement: "TC-002" },
    },
    {
      id: "TC-004",
      title: "Retired case",
      area: "staleness",
      level: 3,
      lifecycle: { state: "retired" as const, reason: "behaviour removed" },
    },
    {
      id: "TC-005",
      title: "Points back at the origin",
      area: "staleness",
      level: 1,
      lifecycle: { state: "superseded" as const, replacement: "TC-001" },
    },
    ...DEEP,
  ],
};

const VERIFY_GATE_PLAN = {
  specSlug: "verify-gate",
  cases: [
    {
      id: "VG-TC-004",
      title: "A gating case that is absent reads as pending",
      area: "gate",
      level: 1,
    },
    { id: "VG-TC-011", title: "An all-L3 gate narrows to no gating cases", area: "gate", level: 1 },
  ],
};

function payload(slug: string): ReplacementCandidatesResponse {
  return {
    originSlug: "testbench",
    slug,
    specs: SPECS,
    plans:
      slug === "testbench"
        ? { testbench: TESTBENCH_PLAN }
        : { testbench: TESTBENCH_PLAN, "verify-gate": VERIFY_GATE_PLAN },
    specLifecycles: {},
  };
}

function mountPicker(onConfirm = vi.fn(), onClose = vi.fn()) {
  render(
    <ReplacementPicker
      isOpen
      onClose={onClose}
      projectId="p1"
      benchId={4}
      originCaseId="TC-001"
      originCaseArea="reconcile"
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCandidates.mockImplementation(
    (_projectId: string, _benchId: number, slug: string | undefined) =>
      ({
        data: payload(slug ?? "testbench"),
        isLoading: false,
        isError: false,
        error: null,
      }) as never,
  );
});

// SATCA-TC-073
describe("ReplacementPicker default specification and case list", () => {
  it("defaults to the case's own specification and says so", () => {
    mountPicker();
    expect(screen.getByTestId("replacement-spec-hint")).toHaveTextContent(
      "Defaults to this case's own specification, testbench.",
    );
    expect(screen.getByRole("button", { name: /testbench \(this spec\)/ })).toBeInTheDocument();
  });

  it("lists the spec's cases with id, title, level, and status", () => {
    mountPicker();
    const option = screen.getByTestId("replacement-option-TC-002");
    expect(within(option).getByText("TC-002")).toBeInTheDocument();
    expect(within(option).getByText("Live sibling case")).toBeInTheDocument();
    expect(within(option).getByText("L2")).toBeInTheDocument();
    expect(within(option).getByText("live")).toBeInTheDocument();

    // A non-live case reports its lifecycle state as its status.
    expect(
      within(screen.getByTestId("replacement-option-TC-004")).getByText("retired"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("replacement-option-TC-003")).getByText("superseded"),
    ).toBeInTheDocument();
  });

  it("excludes the case being superseded", () => {
    mountPicker();
    expect(screen.queryByTestId("replacement-option-TC-001")).not.toBeInTheDocument();
    // 14 of the spec's 15 cases remain on offer.
    expect(screen.getAllByRole("option")).toHaveLength(14);
  });
});

// SATCA-TC-074
describe("ReplacementPicker cross-specification choice", () => {
  it("switches the case list, clears the selection, and records a slug-qualified pointer", async () => {
    const user = userEvent.setup();
    const { onConfirm } = mountPicker();

    // A selection in the origin spec first, so the switch has something to clear.
    await user.click(screen.getByTestId("replacement-option-TC-002"));
    expect(screen.getByTestId("replacement-confirm")).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /testbench \(this spec\)/ }));
    await user.click(screen.getByRole("option", { name: "verify-gate" }));

    // The list is that spec's cases now, and the earlier choice is gone.
    expect(screen.queryByTestId("replacement-option-TC-002")).not.toBeInTheDocument();
    expect(screen.getByTestId("replacement-option-VG-TC-004")).toBeInTheDocument();
    expect(screen.getByTestId("replacement-confirm")).toBeDisabled();
    expect(screen.getByTestId("replacement-preview")).toHaveTextContent(
      "Select a replacement to see how it resolves.",
    );

    await user.click(screen.getByTestId("replacement-option-VG-TC-004"));
    await user.click(screen.getByTestId("replacement-confirm"));

    // Slug-qualified, not bare: the target lives in another specification.
    expect(onConfirm).toHaveBeenCalledWith("verify-gate:VG-TC-004");
  });
});

// SATCA-TC-075
describe("ReplacementPicker filtering, grouping, and counts", () => {
  it("groups by area with the superseded case's own area first, and states the total", () => {
    mountPicker();
    expect(screen.getByTestId("replacement-count")).toHaveTextContent(
      "14 of 14 cases, same area first",
    );
    const groups = screen.getAllByRole("group");
    // "reconcile" is the origin case's area, so it leads even though "deep"
    // sorts before it alphabetically.
    expect(groups[0]).toHaveAccessibleName("reconcile");
    expect(within(groups[0]).getByText(/same area/)).toBeInTheDocument();
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "reconcile",
      "deep",
      "staleness",
    ]);
  });

  it("filters by id, by title, and by area, updating the count each time", async () => {
    const user = userEvent.setup();
    mountPicker();
    const filter = screen.getByTestId("replacement-filter");

    await user.type(filter, "TC-004");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("replacement-count")).toHaveTextContent("1 of 14 cases");

    await user.clear(filter);
    await user.type(filter, "sibling");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByTestId("replacement-option-TC-002")).toBeInTheDocument();

    await user.clear(filter);
    await user.type(filter, "staleness");
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByTestId("replacement-count")).toHaveTextContent("3 of 14 cases");
  });

  it("shows an empty state rather than a blank panel when nothing matches", async () => {
    const user = userEvent.setup();
    mountPicker();
    await user.type(screen.getByTestId("replacement-filter"), "zzzz");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByTestId("replacement-empty")).toHaveTextContent(
      "No case matches that filter.",
    );
  });
});

// SATCA-TC-076
describe("ReplacementPicker resolution preview", () => {
  it("states a direct resolution to a live case", async () => {
    const user = userEvent.setup();
    mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-002"));
    expect(screen.getByTestId("replacement-preview")).toHaveTextContent(
      "Resolves directly to TC-002, which is live.",
    );
    expect(screen.getByTestId("replacement-confirm")).toBeEnabled();
  });

  it("names the case a chain finally resolves to, and shows the chain", async () => {
    const user = userEvent.setup();
    mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-003"));
    const preview = screen.getByTestId("replacement-preview");
    expect(preview).toHaveTextContent("That case is itself superseded.");
    expect(preview).toHaveTextContent("The chain resolves to TC-002");
    expect(preview).toHaveTextContent("TC-001 → TC-003 → TC-002");
    expect(screen.getByTestId("replacement-confirm")).toBeEnabled();
  });

  it("says a chain ending at a retired case would not resolve", async () => {
    const user = userEvent.setup();
    mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-004"));
    const preview = screen.getByTestId("replacement-preview");
    expect(preview).toHaveTextContent("The chain ends at a retired case.");
    expect(preview).toHaveTextContent(
      "This pointer would not resolve, so the gate would stay non-passing.",
    );
    expect(screen.getByTestId("replacement-confirm")).toBeDisabled();
  });

  it("surfaces an archived target spec's supersededBy slug as the remedy", async () => {
    const user = userEvent.setup();
    mockCandidates.mockImplementation(
      (_projectId: string, _benchId: number, slug: string | undefined) =>
        ({
          data: {
            ...payload(slug ?? "testbench"),
            specLifecycles: {
              "verify-gate": { archived: true as const, supersededBy: "integration-plugins" },
            },
          },
          isLoading: false,
          isError: false,
          error: null,
        }) as never,
    );
    mountPicker();

    await user.click(screen.getByRole("button", { name: /testbench \(this spec\)/ }));
    await user.click(screen.getByRole("option", { name: /verify-gate/ }));
    await user.click(screen.getByTestId("replacement-option-VG-TC-004"));

    const preview = screen.getByTestId("replacement-preview");
    expect(preview).toHaveTextContent("The chain lands in an archived specification.");
    expect(preview).toHaveTextContent(
      "That specification was superseded by integration-plugins. Choose a case there instead.",
    );
    expect(screen.getByTestId("replacement-confirm")).toBeDisabled();
  });
});

// SATCA-TC-077
describe("ReplacementPicker refuses an unresolvable choice", () => {
  it("names a cycle and offers no confirmation", async () => {
    const user = userEvent.setup();
    mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-005"));
    const preview = screen.getByTestId("replacement-preview");
    expect(preview).toHaveTextContent("That choice creates a cycle, which fails closed.");
    expect(preview).toHaveTextContent("TC-001 → TC-005 → TC-001");
    expect(screen.getByTestId("replacement-confirm")).toBeDisabled();
  });

  it("names the depth limit and offers no confirmation", async () => {
    const user = userEvent.setup();
    mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-D01"));
    expect(screen.getByTestId("replacement-preview")).toHaveTextContent(
      "The chain is longer than the depth limit of 10 hops, so it fails closed.",
    );
    expect(screen.getByTestId("replacement-confirm")).toBeDisabled();
  });

  it("writes nothing when the dialog is abandoned", async () => {
    const user = userEvent.setup();
    const { onConfirm, onClose } = mountPicker();
    await user.click(screen.getByTestId("replacement-option-TC-002"));
    await user.click(screen.getByTestId("replacement-cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
