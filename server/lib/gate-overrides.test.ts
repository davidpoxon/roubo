import { describe, it, expect } from "vitest";
import {
  applyGateOverrides,
  validateCoversPartition,
  validateGatingSetPartition,
  mintMergeGateId,
  mintSplitGateId,
  type WorkUnitCaseMap,
} from "./gate-overrides.js";
import type { VerifyUnit } from "./gate-evaluator.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";
import {
  emptyGateOverrides,
  type GateOverridesFile,
  type GateOverrideOp,
} from "@roubo/shared/gate-overrides-contract";

function gate(
  id: string,
  testCaseIds: string[],
  covers: string[] = [],
  slug = "verify-gate",
): LoadedVerifyUnit {
  const unit: VerifyUnit = {
    id,
    title: `Verify ${id}`,
    type: "task",
    kind: "verify",
    description: "gate",
    acceptance_criteria: [],
    depends_on: [],
    covers,
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: testCaseIds },
  };
  return { slug, unit };
}

function doc(ops: GateOverrideOp[]): GateOverridesFile {
  return { ...emptyGateOverrides(), ops };
}

const EMPTY_MAP: WorkUnitCaseMap = new Map();

describe("applyGateOverrides - passthrough", () => {
  it("returns loaded gates unchanged when there are no ops", () => {
    const loaded = [gate("WU-A", ["TC-001"]), gate("WU-B", ["TC-002"])];
    const result = applyGateOverrides(loaded, emptyGateOverrides(), EMPTY_MAP);
    expect(result.dropped).toEqual([]);
    expect(result.gates.map((g) => g.unit.id)).toEqual(["WU-A", "WU-B"]);
  });

  it("does not mutate its inputs", () => {
    const loaded = [gate("WU-A", ["TC-001"], ["WU-031"])];
    const frozenIds = loaded[0].unit.implements.test_case_ids;
    applyGateOverrides(loaded, doc([{ op: "merge", gateIds: ["WU-A", "WU-B"] }]), EMPTY_MAP);
    expect(loaded[0].unit.implements.test_case_ids).toBe(frozenIds);
    expect(loaded).toHaveLength(1);
  });
});

describe("applyGateOverrides - merge (AC1, TC-022)", () => {
  it("merges two phase gates into one whose gating set is the deduped union", () => {
    // TC-022: Phase 2 covers TC-019/020/024; Phase 3 covers TC-030/031.
    const loaded = [
      gate("PHASE-2", ["TC-019", "TC-020", "TC-024"], ["WU-031", "WU-032", "WU-033"]),
      gate("PHASE-3", ["TC-030", "TC-031"], ["WU-050", "WU-051"]),
    ];
    const result = applyGateOverrides(
      loaded,
      doc([{ op: "merge", gateIds: ["PHASE-2", "PHASE-3"] }]),
      EMPTY_MAP,
    );
    expect(result.dropped).toEqual([]);
    expect(result.gates).toHaveLength(1);
    const merged = result.gates[0].unit;
    // S001-O02: the 5 cases, no duplicates.
    expect(merged.implements.test_case_ids).toEqual([
      "TC-019",
      "TC-020",
      "TC-024",
      "TC-030",
      "TC-031",
    ]);
    expect(merged.covers).toEqual(["WU-031", "WU-032", "WU-033", "WU-050", "WU-051"]);
    // The source cards are gone (S001-O01 combined card replaces both).
    expect(result.gates.map((g) => g.unit.id)).not.toContain("PHASE-2");
  });

  it("dedups overlapping cases in the union (no duplicates)", () => {
    const loaded = [gate("G1", ["TC-001", "TC-002"]), gate("G2", ["TC-002", "TC-003"])];
    const result = applyGateOverrides(
      loaded,
      doc([{ op: "merge", gateIds: ["G1", "G2"] }]),
      EMPTY_MAP,
    );
    expect(result.gates[0].unit.implements.test_case_ids).toEqual(["TC-001", "TC-002", "TC-003"]);
  });

  it("mints a deterministic merged gate id", () => {
    const loaded = [gate("G2", ["TC-002"]), gate("G1", ["TC-001"])];
    const result = applyGateOverrides(
      loaded,
      doc([{ op: "merge", gateIds: ["G2", "G1"] }]),
      EMPTY_MAP,
    );
    expect(result.gates[0].unit.id).toBe(mintMergeGateId(["G1", "G2"]));
  });

  it("drops a merge that references an unknown gate id (reconciliation)", () => {
    const loaded = [gate("G1", ["TC-001"])];
    const result = applyGateOverrides(
      loaded,
      doc([{ op: "merge", gateIds: ["G1", "GHOST"] }]),
      EMPTY_MAP,
    );
    expect(result.gates.map((g) => g.unit.id)).toEqual(["G1"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("GHOST");
  });

  it("drops a cross-slug merge", () => {
    const loaded = [gate("G1", ["TC-001"], [], "spec-a"), gate("G2", ["TC-002"], [], "spec-b")];
    const result = applyGateOverrides(
      loaded,
      doc([{ op: "merge", gateIds: ["G1", "G2"] }]),
      EMPTY_MAP,
    );
    expect(result.gates).toHaveLength(2);
    expect(result.dropped[0].reason).toContain("across specs");
  });

  it("carries the source units as mergedFrom so sign-off can fan out over them (issue #435)", () => {
    const loaded = [gate("G1", ["TC-001"]), gate("G2", ["TC-002"])];
    const result = applyGateOverrides(
      loaded,
      doc([{ op: "merge", gateIds: ["G1", "G2"] }]),
      EMPTY_MAP,
    );
    // The synthetic merged unit itself stays tracker-less (it has no filed issue).
    expect(result.gates[0].unit.tracker).toBeUndefined();
    // mergedFrom carries the real source units (each would carry its own tracker).
    expect(result.gates[0].mergedFrom?.map((u) => u.id)).toEqual(["G1", "G2"]);
  });

  it("flattens a nested merge's mergedFrom to the filed leaf sources (issue #435)", () => {
    // Merge G1+G2, then merge that synthetic gate with G3: the twice-merged gate's
    // mergedFrom must be the three real leaves, never the tracker-less intermediate.
    const loaded = [gate("G1", ["TC-001"]), gate("G2", ["TC-002"]), gate("G3", ["TC-003"])];
    const firstMergeId = mintMergeGateId(["G1", "G2"]);
    const result = applyGateOverrides(
      loaded,
      doc([
        { op: "merge", gateIds: ["G1", "G2"] },
        { op: "merge", gateIds: [firstMergeId, "G3"] },
      ]),
      EMPTY_MAP,
    );
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0].mergedFrom?.map((u) => u.id)).toEqual(["G1", "G2", "G3"]);
  });

  it("leaves mergedFrom absent on a passthrough (non-merged) gate", () => {
    const loaded = [gate("G1", ["TC-001"])];
    const result = applyGateOverrides(loaded, emptyGateOverrides(), EMPTY_MAP);
    expect(result.gates[0].mergedFrom).toBeUndefined();
  });
});

describe("applyGateOverrides - split (AC2, TC-023)", () => {
  // TC-023: Phase 2 covers WU-031..034 (TC-019/020/024/025).
  const caseMap: WorkUnitCaseMap = new Map([
    ["WU-031", ["TC-019"]],
    ["WU-032", ["TC-020"]],
    ["WU-033", ["TC-024"]],
    ["WU-034", ["TC-025"]],
  ]);

  it("splits one gate into two whose gating sets partition the original", () => {
    const loaded = [
      gate(
        "PHASE-2",
        ["TC-019", "TC-020", "TC-024", "TC-025"],
        ["WU-031", "WU-032", "WU-033", "WU-034"],
      ),
    ];
    const result = applyGateOverrides(
      loaded,
      doc([
        {
          op: "split",
          gateId: "PHASE-2",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031", "WU-032"] },
            { label: "B", coversWorkUnitIds: ["WU-033", "WU-034"] },
          ],
        },
      ]),
      caseMap,
    );
    expect(result.dropped).toEqual([]);
    expect(result.gates).toHaveLength(2);
    const [a, b] = result.gates;
    // S001-O02: split A covers WU-031/032 -> TC-019/020; split B -> TC-024/025.
    expect(a.unit.implements.test_case_ids).toEqual(["TC-019", "TC-020"]);
    expect(b.unit.implements.test_case_ids).toEqual(["TC-024", "TC-025"]);
    // S002-O01: total is 4, no loss or duplication.
    const all = result.gates.flatMap((g) => g.unit.implements.test_case_ids);
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
    expect(result.gates.map((g) => g.unit.id)).not.toContain("PHASE-2");
  });

  it("carries the source gate as mergedFrom on every split part so sign-off can fan out (issue #445)", () => {
    const loaded = [
      gate(
        "PHASE-2",
        ["TC-019", "TC-020", "TC-024", "TC-025"],
        ["WU-031", "WU-032", "WU-033", "WU-034"],
      ),
    ];
    const result = applyGateOverrides(
      loaded,
      doc([
        {
          op: "split",
          gateId: "PHASE-2",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031", "WU-032"] },
            { label: "B", coversWorkUnitIds: ["WU-033", "WU-034"] },
          ],
        },
      ]),
      caseMap,
    );
    expect(result.gates).toHaveLength(2);
    for (const part of result.gates) {
      // The synthetic split unit itself stays tracker-less (it has no filed issue).
      expect(part.unit.tracker).toBeUndefined();
      // Each part carries the real source gate (which would carry its own tracker),
      // so the route can fan sign-off / reopen / signed-off / fix-issue out over it.
      expect(part.mergedFrom?.map((u) => u.id)).toEqual(["PHASE-2"]);
    }
  });

  it("flattens a split-of-a-merge's mergedFrom to the filed leaf sources (issue #445)", () => {
    // Merge G1+G2, then split the synthetic merged gate: each part's mergedFrom
    // must be the two real leaves, never the tracker-less merged intermediate.
    const leafMap: WorkUnitCaseMap = new Map([
      ["WU-031", ["TC-019"]],
      ["WU-032", ["TC-020"]],
    ]);
    const loaded = [gate("G1", ["TC-019"], ["WU-031"]), gate("G2", ["TC-020"], ["WU-032"])];
    const mergedId = mintMergeGateId(["G1", "G2"]);
    const result = applyGateOverrides(
      loaded,
      doc([
        { op: "merge", gateIds: ["G1", "G2"] },
        {
          op: "split",
          gateId: mergedId,
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-032"] },
          ],
        },
      ]),
      leafMap,
    );
    expect(result.gates).toHaveLength(2);
    for (const part of result.gates) {
      expect(part.mergedFrom?.map((u) => u.id)).toEqual(["G1", "G2"]);
    }
  });

  it("leaves mergedFrom absent on a passthrough gate that is not split", () => {
    const loaded = [gate("PHASE-2", ["TC-019"], ["WU-031"])];
    const result = applyGateOverrides(loaded, emptyGateOverrides(), caseMap);
    expect(result.gates[0].mergedFrom).toBeUndefined();
  });

  it("drops a split whose parts do not cover every source WU (loss)", () => {
    const loaded = [gate("PHASE-2", ["TC-019", "TC-020"], ["WU-031", "WU-032"])];
    const result = applyGateOverrides(
      loaded,
      doc([
        {
          op: "split",
          gateId: "PHASE-2",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-031"] },
          ],
        },
      ]),
      caseMap,
    );
    expect(result.gates.map((g) => g.unit.id)).toEqual(["PHASE-2"]);
    expect(result.dropped).toHaveLength(1);
  });

  it("drops a split that assigns a WU not in the source's covers", () => {
    const loaded = [gate("PHASE-2", ["TC-019"], ["WU-031"])];
    const result = applyGateOverrides(
      loaded,
      doc([
        {
          op: "split",
          gateId: "PHASE-2",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-099"] },
          ],
        },
      ]),
      caseMap,
    );
    expect(result.dropped[0].reason).toContain("WU-099");
  });

  it("drops a split referencing an unknown gate id", () => {
    const result = applyGateOverrides(
      [gate("OTHER", ["TC-001"])],
      doc([
        {
          op: "split",
          gateId: "GHOST",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-032"] },
          ],
        },
      ]),
      caseMap,
    );
    expect(result.dropped[0].reason).toContain("GHOST");
  });

  it("mints deterministic split gate ids", () => {
    expect(mintSplitGateId("PHASE-2", "A")).toBe("SPLIT:PHASE-2:A");
  });

  it("drops a split whose covers partition but whose gating sets duplicate a case (AC2)", () => {
    // Two covers in different parts implement the SAME TC- id, so the gating
    // case would appear in both split gates: a covers-only partition does not
    // guarantee the gating-set partition AC2 requires.
    const dupMap: WorkUnitCaseMap = new Map([
      ["WU-031", ["TC-019"]],
      ["WU-032", ["TC-019"]],
    ]);
    const loaded = [gate("PHASE-2", ["TC-019"], ["WU-031", "WU-032"])];
    const result = applyGateOverrides(
      loaded,
      doc([
        {
          op: "split",
          gateId: "PHASE-2",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-032"] },
          ],
        },
      ]),
      dupMap,
    );
    expect(result.gates.map((g) => g.unit.id)).toEqual(["PHASE-2"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("more than one split part");
  });

  it("drops a split whose covers partition but loses a declared gating case (AC2)", () => {
    // The source gate declares TC-099, but no covering unit's case map yields it,
    // so the union of the parts' gating sets would lose it: a fail-closed gap.
    const loaded = [gate("PHASE-2", ["TC-019", "TC-020", "TC-099"], ["WU-031", "WU-032"])];
    const result = applyGateOverrides(
      loaded,
      doc([
        {
          op: "split",
          gateId: "PHASE-2",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-032"] },
          ],
        },
      ]),
      caseMap,
    );
    expect(result.gates.map((g) => g.unit.id)).toEqual(["PHASE-2"]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain("TC-099");
  });
});

describe("validateGatingSetPartition", () => {
  it("accepts an exact partition of the source gating set", () => {
    expect(
      validateGatingSetPartition(["TC-1", "TC-2", "TC-3"], [["TC-1"], ["TC-2", "TC-3"]]),
    ).toBeNull();
  });
  it("rejects a gating case in more than one part (duplication)", () => {
    expect(validateGatingSetPartition(["TC-1", "TC-2"], [["TC-1"], ["TC-1", "TC-2"]])).toContain(
      "more than one split part",
    );
  });
  it("rejects loss of a declared gating case", () => {
    expect(validateGatingSetPartition(["TC-1", "TC-2", "TC-3"], [["TC-1"], ["TC-2"]])).toContain(
      "lose gating case",
    );
  });
  it("rejects a part introducing a case not in the source gating set", () => {
    expect(validateGatingSetPartition(["TC-1"], [["TC-1"], ["TC-9"]])).toContain("introduce");
  });
});

describe("validateCoversPartition", () => {
  it("accepts an exact partition", () => {
    expect(validateCoversPartition(["a", "b", "c"], [["a"], ["b", "c"]])).toBeNull();
  });
  it("rejects an overlap", () => {
    expect(validateCoversPartition(["a", "b"], [["a"], ["a", "b"]])).toContain("more than one");
  });
  it("rejects loss", () => {
    expect(validateCoversPartition(["a", "b", "c"], [["a"], ["b"]])).toContain("not assigned");
  });
  it("rejects an out-of-range id", () => {
    expect(validateCoversPartition(["a"], [["a"], ["z"]])).toContain("z");
  });
});
