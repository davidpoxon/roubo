import { describe, expect, it } from "vitest";
import {
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, type DeliveryResults } from "@roubo/shared/delivery-reducer";
import type { CaseResult, CaseStatus, TestCasesPlan } from "@roubo/shared/testbench-contracts";
import {
  DELIVERY_CROSS_CHECK_BLOCKING,
  DELIVERY_CROSS_CHECK_CLASSES,
  crossCheckDelivery,
  type DeliveryGitObservation,
  type DeliveryPullRequestsObservation,
  type DeliveryStacksObservation,
} from "./delivery-cross-check";

// ── Inline fixtures ──
//
// Four units A, B and C on one stack and D on its own, with a gate after B and
// a provisional gate after C, as the SB-TC-069 and SB-TC-076 preconditions set
// them. The agreeing observation of each source matches the record exactly; each
// test then changes the one value it needs.

const PLAN_HASH = "plan-hash-1";
const UPDATED_AT = "2026-10-16T09:30:00Z";
const BEFORE_UPDATE = "2026-10-16T09:00:00Z";

const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
const HEAD = { A: "a".repeat(40), B: "b".repeat(40), C: "c".repeat(40), D: "d".repeat(40) };

function unit(id: "A" | "B" | "C" | "D", stack: string, layer: number, dependsOn: string[]) {
  return {
    id,
    title: `Unit ${id}`,
    status: "running",
    stack,
    layer,
    depends_on: dependsOn,
    branch: BRANCH[id],
    head: HEAD[id],
    pr_url: `https://github.com/example/fixture/pull/${id}`,
  };
}

function buildRecord(): DeliveryRecord {
  const raw: unknown = {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: PLAN_HASH,
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      gates: [
        {
          id: "gate-after-b",
          after: ["B"],
          status: "passed",
          cases: ["FX-TC-001", "FX-TC-002"],
        },
        {
          id: "gate-after-c",
          after: ["C"],
          status: "provisional",
          cases: ["FX-TC-003"],
          provisionalCases: [
            { case: "FX-TC-003", mark: "met", evidence: "The suite row passed.", confirmed: false },
          ],
        },
      ],
    },
    units: [
      unit("A", "A", 0, []),
      unit("B", "A", 1, ["A"]),
      unit("C", "A", 2, ["B"]),
      unit("D", "D", 0, []),
    ],
    decisions: [],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: {},
    health: { status: "ok", checked_at: UPDATED_AT },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: BEFORE_UPDATE, ended_at: null },
    last_event_seq: 0,
    updated_at: UPDATED_AT,
  };
  const parsed = validateDeliveryRecord(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.data;
}

function caseResult(status: CaseStatus): CaseResult {
  return { observationMarks: {}, derivedStatus: status, notes: [] };
}

function buildResults(
  planHash = PLAN_HASH,
  statuses: Record<string, CaseStatus> = {},
): DeliveryResults {
  const caseResults: Record<string, CaseResult> = {};
  for (const id of ["FX-TC-001", "FX-TC-002", "FX-TC-003"]) {
    caseResults[id] = caseResult(statuses[id] ?? "passed");
  }
  return { planHash, caseResults, updatedAt: UPDATED_AT };
}

// The branches of every unit, less those of the units in `missing`.
function buildGit(
  missing: ReadonlyArray<"A" | "B" | "C" | "D"> = [],
): Record<string, { localHead: string; remoteHead: string | null; committedAt: string }> {
  const git: Record<string, { localHead: string; remoteHead: string | null; committedAt: string }> =
    {};
  for (const id of ["A", "B", "C", "D"] as const) {
    if (missing.includes(id)) continue;
    git[BRANCH[id]] = { localHead: HEAD[id], remoteHead: HEAD[id], committedAt: BEFORE_UPDATE };
  }
  return git;
}

function buildStacks(): Record<string, string[]> {
  return { A: [BRANCH.A, BRANCH.B, BRANCH.C], D: [BRANCH.D] };
}

function buildPullRequests(): Record<string, { state: string; baseBranch: string; url: string }> {
  const base = { A: "main", B: BRANCH.A, C: BRANCH.B, D: "main" };
  const pullRequests: Record<string, { state: string; baseBranch: string; url: string }> = {};
  for (const id of ["A", "B", "C", "D"] as const) {
    pullRequests[BRANCH[id]] = {
      state: "OPEN",
      baseBranch: base[id],
      url: `https://github.com/example/fixture/pull/${id}`,
    };
  }
  return pullRequests;
}

function agreeing() {
  return {
    snapshot: foldDelivery({ record: buildRecord(), events: [] }),
    git: buildGit(),
    stacks: buildStacks(),
    pullRequests: buildPullRequests(),
    results: buildResults(),
  };
}

function run(inputs: ReturnType<typeof agreeing>) {
  return crossCheckDelivery(
    inputs.snapshot,
    inputs.git as DeliveryGitObservation,
    inputs.stacks as DeliveryStacksObservation,
    inputs.pullRequests as DeliveryPullRequestsObservation,
    inputs.results,
  );
}

// ── Tests ──

describe("crossCheckDelivery", () => {
  it("SB-TC-069 returns one entry per injected disagreement across the nine classes", () => {
    const inputs = agreeing();
    // branch-missing: git has no branch for D.
    inputs.git = buildGit(["D"]);
    // head-commit-differs: A's local head is not the head the record claims.
    inputs.git[BRANCH.A].localHead = "e".repeat(40);
    // record-stale: A's head was committed after the record's updated_at.
    inputs.git[BRANCH.A].committedAt = "2026-10-16T09:45:00Z";
    // layer-order-differs: the stacks resource lists C below B.
    inputs.stacks.A = [BRANCH.A, BRANCH.C, BRANCH.B];
    // pr-state-differs: B's pull request was closed by hand.
    inputs.pullRequests[BRANCH.B].state = "CLOSED";
    // base-branch-differs: C's pull request targets the trunk, not B's branch.
    inputs.pullRequests[BRANCH.C].baseBranch = "main";
    // case-status-differs: the provisional met mark on FX-TC-003 meets a failure.
    // plan-hash-mismatch: the results belong to another plan, so the gate the
    // record claims passed reads stale (gate-state-differs).
    inputs.results = buildResults("plan-hash-2", { "FX-TC-003": "failed" });

    const entries = run(inputs);

    expect(entries).toEqual([
      {
        class: "branch-missing",
        blocking: true,
        unitId: "D",
        claimed: BRANCH.D,
        observed: null,
        source: "git",
      },
      {
        class: "head-commit-differs",
        blocking: true,
        unitId: "A",
        claimed: { local: HEAD.A },
        observed: { local: "e".repeat(40) },
        source: "git",
      },
      {
        class: "layer-order-differs",
        blocking: false,
        stack: "A",
        claimed: [BRANCH.A, BRANCH.B, BRANCH.C],
        observed: [BRANCH.A, BRANCH.C, BRANCH.B],
        source: "stack",
      },
      {
        class: "pr-state-differs",
        blocking: true,
        unitId: "B",
        blocksAbove: ["C"],
        claimed: "https://github.com/example/fixture/pull/B",
        observed: "closed",
        source: "pull-request-api",
      },
      {
        class: "base-branch-differs",
        blocking: false,
        unitId: "C",
        claimed: BRANCH.B,
        observed: "main",
        source: "pull-request-api",
      },
      {
        class: "gate-state-differs",
        blocking: true,
        unitId: "gate-after-b",
        claimed: "passed",
        observed: "stale",
        source: "test-results.json",
      },
      {
        class: "case-status-differs",
        blocking: false,
        unitId: "gate-after-c",
        caseId: "FX-TC-003",
        claimed: "met",
        observed: "failed",
        source: "test-results.json",
      },
      {
        class: "plan-hash-mismatch",
        blocking: true,
        claimed: PLAN_HASH,
        observed: "plan-hash-2",
        source: "test-results.json",
      },
      {
        class: "record-stale",
        blocking: false,
        unitId: "A",
        claimed: UPDATED_AT,
        observed: "2026-10-16T09:45:00Z",
        source: "git",
      },
    ]);
    expect(entries).toHaveLength(9);
    expect(new Set(entries.map((e) => e.class))).toEqual(new Set(DELIVERY_CROSS_CHECK_CLASSES));
  });

  it("SB-TC-069 returns an empty list for agreeing inputs", () => {
    expect(run(agreeing())).toEqual([]);
  });

  it("SB-TC-076 names the layers a closed mid-stack pull request blocks above it", () => {
    const inputs = agreeing();
    inputs.pullRequests[BRANCH.B].state = "closed";

    const entries = run(inputs);

    expect(entries).toEqual([
      {
        class: "pr-state-differs",
        blocking: true,
        unitId: "B",
        blocksAbove: ["C"],
        claimed: "https://github.com/example/fixture/pull/B",
        observed: "closed",
        source: "pull-request-api",
      },
    ]);
  });

  it("SB-TC-069 reads the gate through evaluateGate when the record claims passed over a failed case", () => {
    const inputs = agreeing();
    inputs.results = buildResults(PLAN_HASH, { "FX-TC-002": "failed" });

    expect(run(inputs)).toEqual([
      {
        class: "gate-state-differs",
        blocking: true,
        unitId: "gate-after-b",
        claimed: "passed",
        observed: "failed",
        source: "test-results.json",
      },
    ]);
  });

  it("SB-TC-069 narrows the gating set by the plan when the caller passes it", () => {
    const inputs = agreeing();
    // FX-TC-002 is an L3 case, so the default policy drops it from the gate.
    const plan: TestCasesPlan = {
      $schema: "https://roubo.dev/schema/testbench/test-cases/v1.2.0.json",
      schemaVersion: "1.2.0",
      specSlug: "fixture-spec",
      cases: ["FX-TC-001", "FX-TC-002", "FX-TC-003"].map((id) => ({
        id,
        title: id,
        area: "fixture",
        level: id === "FX-TC-002" ? 3 : 1,
        type: "functional",
        steps: [],
        tags: [],
        linked_requirement_ids: [],
        linked_user_story_ids: [],
      })),
    };
    const results = buildResults(PLAN_HASH, { "FX-TC-002": "failed" });

    expect(
      crossCheckDelivery(inputs.snapshot, inputs.git, inputs.stacks, inputs.pullRequests, results, {
        plan,
      }),
    ).toEqual([]);
  });

  it("SB-TC-069 compares a claimed remote head and a claimed pull request state word", () => {
    const record = buildRecord();
    record.units[0] = { ...record.units[0], remote_head: "f".repeat(40) };
    record.units[3] = { ...record.units[3], pr_state: "merged" };
    const inputs = { ...agreeing(), snapshot: foldDelivery({ record, events: [] }) };

    const entries = run(inputs);

    expect(entries.map((e) => [e.class, e.unitId])).toEqual([
      ["head-commit-differs", "A"],
      ["pr-state-differs", "D"],
    ]);
    expect(entries[0].claimed).toEqual({ local: HEAD.A, remote: "f".repeat(40) });
    expect(entries[1]).toMatchObject({ claimed: "merged", observed: "open", blocking: true });
    expect(entries[1]).not.toHaveProperty("blocksAbove");
  });

  it("SB-TC-069 sets blocking from the class alone, per SB-FR-029", () => {
    expect(DELIVERY_CROSS_CHECK_BLOCKING).toEqual({
      "branch-missing": true,
      "head-commit-differs": true,
      "pr-state-differs": true,
      "gate-state-differs": true,
      "plan-hash-mismatch": true,
      "layer-order-differs": false,
      "base-branch-differs": false,
      "case-status-differs": false,
      "record-stale": false,
    });
  });

  it("SB-TC-069 blocks on a gate the record claims failed while the results read passed", () => {
    const record = buildRecord();
    record.stack.gates[0] = { ...record.stack.gates[0], status: "failed" };
    const inputs = { ...agreeing(), snapshot: foldDelivery({ record, events: [] }) };

    expect(run(inputs)).toEqual([
      {
        class: "gate-state-differs",
        blocking: true,
        unitId: "gate-after-b",
        claimed: "failed",
        observed: "passed",
        source: "test-results.json",
      },
    ]);
  });

  it("SB-TC-076 names no blocked layers when the pull request merged over a claimed open state", () => {
    const record = buildRecord();
    record.units[1] = { ...record.units[1], pr_state: "open" };
    const inputs = { ...agreeing(), snapshot: foldDelivery({ record, events: [] }) };
    inputs.pullRequests[BRANCH.B].state = "MERGED";
    // C's pull request is retargeted to the trunk once B merges.
    inputs.pullRequests[BRANCH.C].baseBranch = "main";

    expect(run(inputs)).toEqual([
      {
        class: "pr-state-differs",
        blocking: true,
        unitId: "B",
        claimed: "open",
        observed: "merged",
        source: "pull-request-api",
      },
    ]);
  });

  it("SB-TC-076 names the layers above a claimed pull request the query did not return", () => {
    const inputs = agreeing();
    inputs.pullRequests = Object.fromEntries(
      Object.entries(inputs.pullRequests).filter(([branch]) => branch !== BRANCH.B),
    );

    expect(run(inputs)).toEqual([
      {
        class: "pr-state-differs",
        blocking: true,
        unitId: "B",
        blocksAbove: ["C"],
        claimed: "https://github.com/example/fixture/pull/B",
        observed: null,
        source: "pull-request-api",
      },
    ]);
  });

  it("SB-TC-069 skips base-branch-differs when the lower unit's pull request merged", () => {
    const inputs = agreeing();
    inputs.pullRequests[BRANCH.B].state = "merged";
    inputs.pullRequests[BRANCH.C].baseBranch = "main";

    expect(run(inputs)).toEqual([]);
  });

  it("SB-TC-069 compares a stack's order only over the branches both sides list", () => {
    const inputs = agreeing();
    inputs.stacks.A = ["main", BRANCH.A, BRANCH.B, "fx/unknown", BRANCH.C];

    expect(run(inputs)).toEqual([]);
  });

  it("SB-TC-069 reports a not_met mark over a passed result as non-blocking", () => {
    const record = buildRecord();
    const gate = record.stack.gates[1];
    record.stack.gates[1] = {
      ...gate,
      provisionalCases: (gate.provisionalCases ?? []).map((mark) => ({
        ...mark,
        mark: "not_met" as const,
      })),
    };
    const inputs = { ...agreeing(), snapshot: foldDelivery({ record, events: [] }) };

    expect(run(inputs)).toEqual([
      {
        class: "case-status-differs",
        blocking: false,
        unitId: "gate-after-c",
        caseId: "FX-TC-003",
        claimed: "not_met",
        observed: "passed",
        source: "test-results.json",
      },
    ]);
  });

  it("SB-TC-069 skips record-stale when a commit time or the record's updated_at does not parse", () => {
    const inputs = agreeing();
    inputs.git[BRANCH.A].committedAt = "not a time";
    inputs.git[BRANCH.B].committedAt = "2026-10-16T09:45:00Z";
    expect(run(inputs).map((e) => [e.class, e.unitId])).toEqual([["record-stale", "B"]]);

    const unparseable = {
      ...inputs,
      snapshot: {
        ...inputs.snapshot,
        staleness: { ...inputs.snapshot.staleness, updatedAt: "not a time" },
      },
    };
    expect(run(unparseable)).toEqual([]);
  });

  it("SB-TC-069 does not compare a provisional gate word or a missing results file", () => {
    const inputs = agreeing();
    const entries = crossCheckDelivery(
      inputs.snapshot,
      inputs.git,
      inputs.stacks,
      inputs.pullRequests,
      null,
    );
    // Only the gate that claims an evaluator word reads stale without results.
    expect(entries).toEqual([
      {
        class: "gate-state-differs",
        blocking: true,
        unitId: "gate-after-b",
        claimed: "passed",
        observed: "stale",
        source: "test-results.json",
      },
    ]);
  });

  // The gate after B as the record states it, with one provisional mark on
  // FX-TC-001.
  function withGateAfterB(status: string, confirmed: boolean): ReturnType<typeof agreeing> {
    const record = buildRecord();
    record.stack.gates[0] = {
      ...record.stack.gates[0],
      status,
      provisionalCases: [
        { case: "FX-TC-001", mark: "met", evidence: "The suite row passed.", confirmed },
      ],
    };
    return { ...agreeing(), snapshot: foldDelivery({ record, events: [] }) };
  }

  it.each([
    ["pending", undefined],
    ["passed", "passed"],
    ["failed", "failed"],
  ] as const)(
    "SB-TC-082 gives a provisional gate no gate-state entry when its results read %s",
    (_verdict, status) => {
      const inputs = withGateAfterB("provisional", false);
      const statuses: Record<string, CaseStatus> = {};
      if (status !== undefined) statuses["FX-TC-001"] = status;
      const results = buildResults(PLAN_HASH, statuses);
      // No result for the case reads pending.
      if (status === undefined) delete results.caseResults["FX-TC-001"];
      inputs.results = results;

      const entries = run(inputs);

      expect(entries.filter((e) => e.class === "gate-state-differs")).toEqual([]);
      expect(entries.some((e) => e.blocking)).toBe(false);
    },
  );

  it("SB-TC-082 exposes a gate's provisional cases and the unconfirmed ones on the snapshot", () => {
    const inputs = withGateAfterB("provisional", false);
    expect(inputs.snapshot.gatesById["gate-after-b"].provisional).toEqual({
      cases: ["FX-TC-001"],
      unconfirmed: ["FX-TC-001"],
    });
    expect(agreeing().snapshot.gatesById["gate-after-b"].provisional).toEqual({
      cases: [],
      unconfirmed: [],
    });
  });

  it("SB-TC-096 leaves a stale results verdict on a provisional gate to the blocking plan-hash class", () => {
    const inputs = withGateAfterB("provisional", false);
    inputs.results = buildResults("plan-hash-2");

    expect(run(inputs)).toEqual([
      {
        class: "plan-hash-mismatch",
        blocking: true,
        claimed: PLAN_HASH,
        observed: "plan-hash-2",
        source: "test-results.json",
      },
    ]);
  });

  it.each(["passed", "failed"])(
    "SB-TC-095 gives a gate the record states as %s over an unconfirmed provisional mark one blocking entry exempt for its own sitting",
    (status) => {
      const inputs = withGateAfterB(status, false);

      expect(run(inputs)).toEqual([
        {
          class: "gate-state-differs",
          blocking: true,
          unitId: "gate-after-b",
          sittingExempt: "gate-after-b",
          claimed: status,
          observed: "provisional",
          source: "test-results.json",
        },
      ]);
    },
  );

  it("SB-TC-095 compares a gate whose provisional marks are all confirmed with the evaluator, with no exemption", () => {
    const confirmed = withGateAfterB("passed", true);
    expect(run(confirmed)).toEqual([]);

    const overturned = withGateAfterB("failed", true);
    expect(run(overturned)).toEqual([
      {
        class: "gate-state-differs",
        blocking: true,
        unitId: "gate-after-b",
        claimed: "failed",
        observed: "passed",
        source: "test-results.json",
      },
    ]);
  });

  it("SB-TC-069 is pure: the same inputs give a deep-equal list and are left unchanged", () => {
    const inputs = agreeing();
    inputs.git = buildGit(["D"]);
    inputs.pullRequests[BRANCH.B].state = "closed";
    inputs.results = buildResults("plan-hash-2", { "FX-TC-003": "failed" });
    const before = structuredClone(inputs);

    const first = run(inputs);
    const second = run(inputs);

    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
    expect(inputs).toEqual(before);
  });
});
