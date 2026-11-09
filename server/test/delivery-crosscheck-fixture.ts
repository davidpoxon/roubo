// The fixture delivery of the cross-check tests: four units A, B and C on one
// stack and D on its own, the three cases of its plan, and the files a bench
// workspace's spec folder holds for it. Each test gives the gates of its record
// and the results of its cases.
import fs from "node:fs";
import path from "node:path";
import {
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
} from "@roubo/shared/delivery-observation-contract";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { computePlanHash } from "../lib/testbench-store.js";

export const UPDATED_AT = "2026-10-16T09:30:00Z";
export const BEFORE_UPDATE = "2026-10-16T09:00:00Z";
export const AFTER_UPDATE = "2026-10-16T10:00:00Z";
export const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
export const HEAD = {
  A: "a".repeat(40),
  B: "b".repeat(40),
  C: "c".repeat(40),
  D: "d".repeat(40),
};
export type UnitId = keyof typeof BRANCH;
export const UNITS: UnitId[] = ["A", "B", "C", "D"];
export const CASES = ["FX-TC-001", "FX-TC-002", "FX-TC-003"];

export const CROSS_CHECK_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: "1.2.0",
  specSlug: "fixture-spec",
  cases: CASES.map((id) => ({
    id,
    title: id,
    area: "fixture",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["FX-FR-001"],
    linked_user_story_ids: [],
  })),
};

/** The plan hash of CROSS_CHECK_PLAN, which its results carry. */
export const CROSS_CHECK_PLAN_HASH = computePlanHash(CROSS_CHECK_PLAN);

/** The delivery record of the fixture, with the given plan hash and gates. */
export function crossCheckRecord(planHash: string, gates: unknown[]): unknown {
  const stackOf: Record<UnitId, string> = { A: "A", B: "A", C: "A", D: "D" };
  const layerOf: Record<UnitId, number> = { A: 0, B: 1, C: 2, D: 0 };
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: planHash,
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: { stacks: { A: ["A", "B", "C"], D: ["D"] }, gates },
    units: UNITS.map((id) => ({
      id,
      title: `Unit ${id}`,
      status: "running",
      stack: stackOf[id],
      layer: layerOf[id],
      depends_on: [],
      branch: BRANCH[id],
      head: HEAD[id],
      pr_url: `https://github.com/example/fixture/pull/${id}`,
    })),
    decisions: [],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: {},
    health: { status: "ok", checked_at: UPDATED_AT },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: BEFORE_UPDATE, ended_at: null },
    last_event_seq: 7,
    updated_at: UPDATED_AT,
  };
}

/**
 * Writes the plan, its results and the record into a spec folder. The results
 * carry the plan's own hash; the record carries `recordPlanHash`.
 */
export function writeCrossCheckSpec(
  specFolder: string,
  spec: { recordPlanHash: string; gates: unknown[]; caseResults: Record<string, unknown> },
): void {
  fs.writeFileSync(path.join(specFolder, "test-cases.json"), JSON.stringify(CROSS_CHECK_PLAN));
  fs.writeFileSync(
    path.join(specFolder, "test-results.json"),
    JSON.stringify({
      $schema: TEST_RESULTS_SCHEMA_ID,
      schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
      planHash: CROSS_CHECK_PLAN_HASH,
      caseResults: spec.caseResults,
      updatedAt: UPDATED_AT,
    }),
  );
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(crossCheckRecord(spec.recordPlanHash, spec.gates), null, 2)}\n`,
  );
}
