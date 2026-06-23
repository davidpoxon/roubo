// The pure, deterministic gate-override transform (#703, FR-002, US-007).
//
// `applyGateOverrides` rewrites the loaded verify units (gates) according to the
// operator's recorded merge / split operations, producing the EFFECTIVE gate
// list the API returns and evaluates. It is the sibling of gate-evaluator.ts: a
// pure function with no I/O, no clock, no input mutation, so identical inputs
// yield a deep-equal result.
//
// Why a transform rather than a write: gates are `kind: "verify"` work units
// loaded read-only from each spec's externally-authored work-units.json (Roubo
// never writes that file, see work-unit-loader.ts). The operator's regroupings
// live in a separate Roubo-owned document (gate-overrides-contract.ts) and are
// applied here over the loaded units before evaluation, so the underlying
// breakdown artifact is never mutated.
//
// Each synthetic gate stays a valid VerifyUnit so the existing pure
// `evaluateGate` evaluates it unchanged against its spec's plan + results.
//
// Reconciliation (issue "reconciles with gates already filed by the external
// breakdown"): an op that references a source gate id no longer present among
// the loaded units (the breakdown re-filed gates under different ids) is dropped
// and reported, never fatal. An op whose synthetic result is invalid (a split
// whose parts do not partition the source's covers, a cross-slug merge) is
// likewise dropped with a reason rather than throwing, so one stale op can never
// break the whole gate list.

import type { GateOverridesFile, GateOverrideOp } from "@roubo/shared/gate-overrides-contract";
import type { VerifyUnit } from "./gate-evaluator.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";

// A WU- id -> the test_case_ids that work unit implements, built from the
// NON-verify units of a spec (work-unit-loader.buildWorkUnitCaseMap). Split uses
// it to compute each part's gating set from the WU- ids assigned to that part.
export type WorkUnitCaseMap = ReadonlyMap<string, readonly string[]>;

// A dropped op plus the human-readable reason, surfaced for observability. The
// transform never throws on a stale / invalid op; it drops it and records why.
export interface DroppedOp {
  op: GateOverrideOp;
  reason: string;
}

export interface ApplyResult {
  // The effective gate list: source gates consumed by an applied op are removed
  // and replaced by the op's synthetic gate(s); untouched gates pass through.
  gates: LoadedVerifyUnit[];
  // Ops that could not be applied (missing source gate, cross-slug merge,
  // non-partitioning split) and were dropped, each with a reason.
  dropped: DroppedOp[];
}

// Deduped union preserving first-seen order. Pure.
function dedupe<T>(values: Iterable<T>): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// Mint a deterministic synthetic gate id for a merge from its sorted source ids,
// so the same merge always yields the same id (idempotent re-application,
// stable React keys, stable evaluation identity).
export function mintMergeGateId(sourceGateIds: readonly string[]): string {
  return `MERGED:${[...sourceGateIds].sort().join("+")}`;
}

// Mint a deterministic synthetic gate id for one split part from the source gate
// id and the part label.
export function mintSplitGateId(sourceGateId: string, label: string): string {
  return `SPLIT:${sourceGateId}:${label}`;
}

// Build a synthetic merged VerifyUnit from its source units. The gating set is
// the deduped union of the sources' test_case_ids; `covers` is the deduped union
// of the sources' covers. Other fields are derived so the result reads sensibly
// in the UI while staying a valid VerifyUnit.
function buildMergedUnit(id: string, sources: readonly VerifyUnit[]): VerifyUnit {
  const testCaseIds = dedupe(sources.flatMap((u) => u.implements.test_case_ids));
  const covers = dedupe(sources.flatMap((u) => u.covers ?? []));
  return {
    id,
    title: `Merged gate (${sources.map((u) => u.id).join(", ")})`,
    type: "task",
    kind: "verify",
    description: `Operator-merged gate spanning ${sources.length} phase gates.`,
    acceptance_criteria: [],
    depends_on: [],
    covers,
    implements: {
      requirement_ids: dedupe(sources.flatMap((u) => u.implements.requirement_ids)),
      user_story_ids: dedupe(sources.flatMap((u) => u.implements.user_story_ids)),
      test_case_ids: testCaseIds,
    },
  };
}

// Build a synthetic split VerifyUnit for one part. Its gating set is the deduped
// union of the test_case_ids the assigned WU- ids implement (per the case map).
function buildSplitUnit(
  id: string,
  label: string,
  sourceId: string,
  coversWorkUnitIds: readonly string[],
  caseMap: WorkUnitCaseMap,
): VerifyUnit {
  const testCaseIds = dedupe(coversWorkUnitIds.flatMap((wu) => [...(caseMap.get(wu) ?? [])]));
  return {
    id,
    title: `Split gate ${label} (from ${sourceId})`,
    type: "task",
    kind: "verify",
    description: `Operator-split gate part "${label}" of ${sourceId}.`,
    acceptance_criteria: [],
    depends_on: [],
    covers: [...coversWorkUnitIds],
    implements: {
      requirement_ids: [],
      user_story_ids: [],
      test_case_ids: testCaseIds,
    },
  };
}

// Apply the operator's recorded merge / split ops over the loaded verify units.
//
// `loaded`    the gates as loaded from work-units.json (one entry per verify
//             unit, paired with its spec slug).
// `overrides` the validated override document (ordered op list).
// `caseMap`   WU- id -> test_case_ids, built from the spec's non-verify units;
//             used to compute each split part's gating set.
//
// Pure: no I/O, no mutation of the inputs. Returns the effective gate list plus
// any ops that were dropped during reconciliation.
export function applyGateOverrides(
  loaded: readonly LoadedVerifyUnit[],
  overrides: GateOverridesFile,
  caseMap: WorkUnitCaseMap,
): ApplyResult {
  // Mutable working list keyed by gate id so each op consumes its sources and
  // appends its synthetic result. A Map preserves a deterministic order and lets
  // a later op consume an earlier op's synthetic gate.
  const byId = new Map<string, LoadedVerifyUnit>();
  for (const entry of loaded) {
    byId.set(entry.unit.id, entry);
  }

  const dropped: DroppedOp[] = [];

  for (const op of overrides.ops) {
    if (op.op === "merge") {
      const sourceIds = dedupe(op.gateIds);
      const sources = sourceIds.map((gid) => byId.get(gid));
      const missing = sourceIds.filter((_, i) => sources[i] === undefined);
      if (missing.length > 0) {
        dropped.push({ op, reason: `unknown gate id(s): ${missing.join(", ")}` });
        continue;
      }
      const present = sources as LoadedVerifyUnit[];
      const slugs = dedupe(present.map((s) => s.slug));
      if (slugs.length > 1) {
        dropped.push({
          op,
          reason: `cannot merge gates across specs (${slugs.join(", ")})`,
        });
        continue;
      }
      const slug = present[0].slug;
      const id = mintMergeGateId(sourceIds);
      const unit = buildMergedUnit(
        id,
        present.map((s) => s.unit),
      );
      for (const gid of sourceIds) byId.delete(gid);
      byId.set(id, { slug, unit });
      continue;
    }

    // split
    const source = byId.get(op.gateId);
    if (source === undefined) {
      dropped.push({ op, reason: `unknown gate id: ${op.gateId}` });
      continue;
    }
    const sourceCovers = source.unit.covers ?? [];
    const partitionError = validateCoversPartition(
      sourceCovers,
      op.parts.map((p) => p.coversWorkUnitIds),
    );
    if (partitionError !== null) {
      dropped.push({ op, reason: partitionError });
      continue;
    }
    // Build each part's synthetic unit, then verify the parts' GATING SETS (the
    // TC- ids, not just the covers) partition the source gate's declared gating
    // set with no loss or duplication (AC2). The covers partition above is
    // necessary but not sufficient: the WU- -> TC- map can be many-to-many, so
    // two covers in different parts can implement the same TC- id (cross-part
    // duplication), and the union of the covers' mapped cases may not equal the
    // source gate's own `implements.test_case_ids` (loss or addition relative to
    // the original). Both would violate AC2, so a split that does not partition
    // the gating set exactly is dropped rather than emitting wrong gates.
    const partUnits = op.parts.map((part) => ({
      part,
      unit: buildSplitUnit(
        mintSplitGateId(op.gateId, part.label),
        part.label,
        op.gateId,
        part.coversWorkUnitIds,
        caseMap,
      ),
    }));
    const gatingError = validateGatingSetPartition(
      source.unit.implements.test_case_ids,
      partUnits.map((p) => p.unit.implements.test_case_ids),
    );
    if (gatingError !== null) {
      dropped.push({ op, reason: gatingError });
      continue;
    }
    byId.delete(op.gateId);
    for (const { unit } of partUnits) {
      byId.set(unit.id, { slug: source.slug, unit });
    }
  }

  const gates = [...byId.values()];
  gates.sort((a, b) => a.slug.localeCompare(b.slug) || a.unit.id.localeCompare(b.unit.id));
  return { gates, dropped };
}

// Validate that `parts` partition `sourceCovers` exactly: every WU- id in the
// source's covers appears in exactly one part, and no part names a WU- id that
// is not in the source's covers. Returns null when the partition is valid, else
// a human-readable reason. The split's gating set is therefore lossless and
// duplicate-free (AC2), because the union of the parts' covers equals the
// source's covers with no overlap, and each WU- id maps to a fixed case set.
export function validateCoversPartition(
  sourceCovers: readonly string[],
  partsCovers: readonly (readonly string[])[],
): string | null {
  const allowed = new Set(sourceCovers);
  const assigned = new Set<string>();
  for (const part of partsCovers) {
    for (const wu of part) {
      if (!allowed.has(wu)) {
        return `WU- id "${wu}" is not in the source gate's covers`;
      }
      if (assigned.has(wu)) {
        return `WU- id "${wu}" is assigned to more than one part`;
      }
      assigned.add(wu);
    }
  }
  const unassigned = sourceCovers.filter((wu) => !assigned.has(wu));
  if (unassigned.length > 0) {
    return `WU- id(s) not assigned to any part: ${dedupe(unassigned).join(", ")}`;
  }
  return null;
}

// Validate that the parts' gating sets (their resolved test_case_ids) partition
// the source gate's declared gating set exactly (AC2: "gating sets partition the
// original with no loss or duplication"). Returns null when the partition is
// valid, else a human-readable reason. Two checks:
//   - no duplication: a TC- id may appear in at most one part (a TC delivered by
//     two covers assigned to different parts would otherwise gate twice);
//   - no loss / no addition: the union of the parts' gating sets must equal the
//     source gate's `implements.test_case_ids` as a set, so no original gating
//     case vanishes (fail-closed) and no foreign case is introduced.
export function validateGatingSetPartition(
  sourceGatingSet: readonly string[],
  partsTestCaseIds: readonly (readonly string[])[],
): string | null {
  const assigned = new Set<string>();
  for (const part of partsTestCaseIds) {
    for (const tc of part) {
      if (assigned.has(tc)) {
        return `gating case "${tc}" appears in more than one split part (duplication)`;
      }
      assigned.add(tc);
    }
  }
  const source = new Set(sourceGatingSet);
  const lost = [...source].filter((tc) => !assigned.has(tc));
  if (lost.length > 0) {
    return `split would lose gating case(s) from the original gate: ${dedupe(lost).join(", ")}`;
  }
  const added = [...assigned].filter((tc) => !source.has(tc));
  if (added.length > 0) {
    return `split would introduce gating case(s) not in the original gate: ${dedupe(added).join(", ")}`;
  }
  return null;
}
