// REST surface for verify gates (#701, #703, FR-008, FR-012, FR-002, NFR-004;
// architecture.md "Gate API routes" row). Thin handlers in the testbench.ts mold:
// resolve the project repoPath, load the validated verify units (gates) via the
// work-unit-loader, apply the operator's recorded merge / split overrides as a
// pure transform (gate-overrides.ts), then evaluate each effective gate against
// its spec's recorded plan + results with the pure `evaluateGate` and return the
// projected GateState.
//
// Endpoints (mounted under /api/projects):
//   GET    /:projectId/gates            -> 200 GateState[] (one per effective gate)
//   GET    /:projectId/gates/:gateId    -> 200 GateState / 404 (unknown gate id)
//   POST   /:projectId/gates/merge      -> 200 (record a merge op) / 400 / 409
//   POST   /:projectId/gates/split      -> 200 (record a split op) / 400 / 409
//   DELETE /:projectId/gates/overrides  -> 204 (reset all operator regroupings)
//
// Merge / split do NOT mutate the externally-authored work-units.json; they
// persist a Roubo-owned override document (gate-override-store.ts) applied as a
// pure transform at read time, so the effective (regrouped) gates are what the
// GET handlers return and evaluate.
//
// Results sourcing (architecture open question "Root-path resolution"): a gate is
// PROJECT-level, so its plan + results are read from the registered project's
// repoPath under the gate's own spec slug. When no plan/results exist there yet,
// the gate reads as `stale`, never `passed` (NFR-007 fail-closed): an unverified
// gate must never look passable.

import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import { WorkUnitsValidationError } from "../services/work-unit-loader.js";
import type { LoadedVerifyUnit } from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { GateOverrideStoreError } from "../services/gate-override-store.js";
import { applyGateOverrides } from "../lib/gate-overrides.js";
import type { WorkUnitCaseMap } from "../lib/gate-overrides.js";
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError, UnsafePathError } from "../lib/testbench-store.js";
import { evaluateGate } from "../lib/gate-evaluator.js";
import type { GateState } from "../lib/gate-evaluator.js";
import {
  validateGateOverrides,
  type GateOverrideOp,
  type GateOverridesFile,
} from "@roubo/shared/gate-overrides-contract";
import { RouteError } from "./helpers.js";

const router = Router();

// The read handlers resolve a project and read plan/results files from disk per
// gate, so they are rate-limited to mitigate denial-of-service (CodeQL
// js/missing-rate-limiting, alerts 186/187). Mirrors the limiter used by the
// sibling routers (benches-settings.ts, projects.ts).
const gateReadRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// Write handlers (merge / split / reset) persist to disk and re-evaluate, so
// they are rate-limited too, on the same window with a tighter cap.
const gateWriteRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// The API-facing gate projection: the pure evaluator's GateState plus the gate's
// own id, so a list caller can tell the entries apart. The evaluator deliberately
// omits an id to stay pure (no identity / clock); the route stamps it from the
// loaded unit (architecture.md Data model lists `gateId` on GateState).
interface GateStateResponse extends GateState {
  gateId: string;
}

// Resolve a registered project's repoPath, or throw a 404 RouteError. Mirrors the
// helper in testbench.ts so both routers resolve projects identically.
function resolveRepoPath(projectId: string): string {
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.config) {
    throw new RouteError(404, `Project '${projectId}' not found`);
  }
  return project.repoPath;
}

// Map any thrown error to an HTTP response: RouteError carries a statusCode, a
// WorkUnitsValidationError is a present-but-broken artifact (400), a
// GateOverrideStoreError maps by code, and everything else is a 500. A
// MissingPlanError never escapes a handler (it is caught per gate and folded into
// a stale state), so it is not mapped here.
function handleError(res: Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  if (err instanceof WorkUnitsValidationError) {
    res.status(400).json({ error: err.message, errors: err.errors });
    return;
  }
  if (err instanceof GateOverrideStoreError) {
    // INVALID_PROJECT_ID / PARSE / SCHEMA are all bad-request-shaped: a malformed
    // id or a corrupt/invalid override document is a 400, not a 500.
    res.status(400).json({ error: err.message, code: err.code, errors: err.errors });
    return;
  }
  if (err instanceof UnsafePathError) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

// Evaluate a single loaded gate against its spec's recorded plan + results.
//
// The plan + results are read from the project repoPath under the gate's slug.
// When the spec has no plan (or it is unreadable/invalid), `readPlanAndResults`
// throws MissingPlanError; per NFR-007 the gate is then read as `stale` with the
// gate's declared gating set unresolved, NEVER passed. When the plan exists, the
// pure `evaluateGate` decides: the plan is threaded in so the L3/L4 default-policy
// narrowing applies (FR-005, AC3).
function evaluateLoadedGate(repoPath: string, loaded: LoadedVerifyUnit): GateStateResponse {
  const { slug, unit } = loaded;

  let state: GateState;
  try {
    const { plan, results, planHash, stale } = testbenchStore.readPlanAndResults(repoPath, slug);
    // `readPlanAndResults` strips the stored planHash from `results`, exposing the
    // freshness comparison as its `stale` flag instead. The evaluator decides
    // staleness from `results.planHash !== currentPlanHash`, so thread a planHash
    // that reflects the store's verdict: the live hash when fresh, a
    // guaranteed-mismatching sentinel when stale. Passing the live hash on both
    // sides would leave the staleness rung unreachable for a results-present gate,
    // letting stale (plan-changed) all-passed results read as `passed`, a
    // fail-closed regression (NFR-007). A null results view models "no results
    // recorded yet" and reads as stale.
    const gateResults =
      results === null ? null : { ...results, planHash: stale ? `${planHash}::stale` : planHash };
    state = evaluateGate(unit, gateResults, planHash, plan);
  } catch (err) {
    if (err instanceof MissingPlanError) {
      // Fail-closed: no plan means the gate has never been verified. Report it
      // stale with the whole declared gating set unresolved, never passed.
      const unresolvedCaseIds = [...unit.implements.test_case_ids];
      state = {
        status: "stale",
        unresolvedCaseIds,
        coveringUnitIds: unresolvedCaseIds.length > 0 ? (unit.covers ?? []) : [],
      };
    } else {
      throw err;
    }
  }

  return { gateId: unit.id, ...state };
}

// Build the WU- -> test_case_ids map a split needs, for every spec the loaded
// gates span. WU- ids are numbered per spec, so they are spec-scoped in
// practice and cross-spec collisions are not expected. This flat union is
// last-write-wins: if two specs did define the same WU- id, the later spec's
// case set overwrites (replaces, not unions) the earlier one's. That is
// acceptable because a split is always validated against its source gate's own
// covers and declared gating set in applyGateOverrides (validateCoversPartition
// + validateGatingSetPartition), so a wrong-spec case set for a colliding id
// would make the split fail the partition check and be dropped, never silently
// mis-resolved. Validation errors from any spec surface (a broken
// work-units.json is not silently dropped).
function buildCaseMap(repoPath: string, loaded: readonly LoadedVerifyUnit[]): WorkUnitCaseMap {
  const merged = new Map<string, string[]>();
  const seenSlugs = new Set<string>();
  for (const entry of loaded) {
    if (seenSlugs.has(entry.slug)) continue;
    seenSlugs.add(entry.slug);
    for (const [wu, cases] of workUnitLoader.buildWorkUnitCaseMap(repoPath, entry.slug)) {
      merged.set(wu, cases);
    }
  }
  return merged;
}

// Load the project's gates, apply the operator's recorded overrides, and return
// the effective (regrouped) loaded gates. Centralised so the GET handlers and the
// write handlers' guard share the exact same effective view.
function effectiveGates(repoPath: string, projectId: string): LoadedVerifyUnit[] {
  const loaded = workUnitLoader.loadVerifyUnits(repoPath);
  const overrides = gateOverrideStore.loadOverrides(projectId);
  const caseMap = buildCaseMap(repoPath, loaded);
  return applyGateOverrides(loaded, overrides, caseMap).gates;
}

// GET /:projectId/gates -> 200 GateState[] (one per effective gate across the
// project's specs). An empty array is a valid, normal response (no gates yet).
router.get(
  "/:projectId/gates",
  gateReadRateLimiter,
  (req: Request<{ projectId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const gates = effectiveGates(repoPath, req.params.projectId);
      res.json(gates.map((loaded) => evaluateLoadedGate(repoPath, loaded)));
    } catch (err) {
      handleError(res, err);
    }
  },
);

// GET /:projectId/gates/:gateId -> 200 GateState / 404 when no effective gate has
// that id. For a non-passed gate the payload carries the unresolved TC- ids and
// the covering slice unit ids (FR-012, NFR-004).
router.get(
  "/:projectId/gates/:gateId",
  gateReadRateLimiter,
  (req: Request<{ projectId: string; gateId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const gates = effectiveGates(repoPath, req.params.projectId);
      const loaded = gates.find((g) => g.unit.id === req.params.gateId);
      if (loaded === undefined) {
        throw new RouteError(404, `Gate '${req.params.gateId}' not found`);
      }
      res.json(evaluateLoadedGate(repoPath, loaded));
    } catch (err) {
      handleError(res, err);
    }
  },
);

// Guard (AC3): merge / split is prevented when any gate it involves currently
// evaluates to `passed` (the in-scope "signed-off" signal; tracker-issue closure
// is Phase 4 / out of scope). Throws a 409 RouteError with a clear message.
function assertNoneSignedOff(
  repoPath: string,
  effective: readonly LoadedVerifyUnit[],
  gateIds: readonly string[],
): void {
  for (const gateId of gateIds) {
    const loaded = effective.find((g) => g.unit.id === gateId);
    if (loaded === undefined) {
      throw new RouteError(400, `Gate '${gateId}' not found`);
    }
    const state = evaluateLoadedGate(repoPath, loaded);
    if (state.status === "passed") {
      throw new RouteError(
        409,
        `Gate '${gateId}' is signed off (passed) and cannot be merged or split. Reopen it first.`,
      );
    }
  }
}

// Append a new op to the project's override document, then verify the combined
// document still applies cleanly (the new op is not dropped during the pure
// transform). A dropped op means the request is invalid (unknown id,
// non-partitioning split, cross-slug merge): surface a 400 with the reason and
// do NOT persist. On success persist the document and return the recomputed
// effective gate list.
function recordOp(repoPath: string, projectId: string, op: GateOverrideOp, res: Response): void {
  const loaded = workUnitLoader.loadVerifyUnits(repoPath);
  const caseMap = buildCaseMap(repoPath, loaded);
  const existing = gateOverrideStore.loadOverrides(projectId);
  const next: GateOverridesFile = { ...existing, ops: [...existing.ops, op] };

  // Re-validate the combined document (defence-in-depth; the op is already typed).
  const validation = validateGateOverrides(next);
  if (!validation.ok) {
    throw new RouteError(400, validation.errors.join("; "));
  }

  const applied = applyGateOverrides(loaded, validation.data, caseMap);
  // The new op is the last one in the parsed document; if it was dropped, the
  // request was invalid (unknown id, non-partitioning split, cross-slug merge).
  // Compare against the parsed op (validation re-parses, so the dropped op is a
  // distinct object reference from the caller's `op`).
  const parsedNewOp = validation.data.ops[validation.data.ops.length - 1];
  const droppedNew = applied.dropped.find((d) => d.op === parsedNewOp);
  if (droppedNew) {
    throw new RouteError(400, droppedNew.reason);
  }

  gateOverrideStore.saveOverrides(projectId, validation.data);
  res.json(applied.gates.map((g) => evaluateLoadedGate(repoPath, g)));
}

// POST /:projectId/gates/merge { gateIds } -> 200 GateState[] (the recomputed
// effective list) / 400 (unknown id, cross-slug) / 409 (a signed-off gate).
router.post(
  "/:projectId/gates/merge",
  gateWriteRateLimiter,
  (req: Request<{ projectId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const gateIds = req.body?.gateIds;
      if (
        !Array.isArray(gateIds) ||
        gateIds.length < 2 ||
        !gateIds.every((g) => typeof g === "string")
      ) {
        throw new RouteError(400, "merge requires a gateIds array of at least two gate ids");
      }
      const effective = effectiveGates(repoPath, req.params.projectId);
      assertNoneSignedOff(repoPath, effective, gateIds);
      recordOp(repoPath, req.params.projectId, { op: "merge", gateIds }, res);
    } catch (err) {
      handleError(res, err);
    }
  },
);

// POST /:projectId/gates/split { gateId, parts } -> 200 GateState[] / 400
// (unknown id, non-partition) / 409 (a signed-off gate).
router.post(
  "/:projectId/gates/split",
  gateWriteRateLimiter,
  (req: Request<{ projectId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const { gateId, parts } = req.body ?? {};
      if (typeof gateId !== "string" || !Array.isArray(parts) || parts.length < 2) {
        throw new RouteError(400, "split requires a gateId and at least two parts");
      }
      const effective = effectiveGates(repoPath, req.params.projectId);
      assertNoneSignedOff(repoPath, effective, [gateId]);
      recordOp(repoPath, req.params.projectId, { op: "split", gateId, parts }, res);
    } catch (err) {
      handleError(res, err);
    }
  },
);

// DELETE /:projectId/gates/overrides -> 204. Reset all operator regroupings; the
// effective gates revert to the externally-authored work-units.json gates.
router.delete(
  "/:projectId/gates/overrides",
  gateWriteRateLimiter,
  (req: Request<{ projectId: string }>, res: Response) => {
    try {
      resolveRepoPath(req.params.projectId);
      gateOverrideStore.removeOverrides(req.params.projectId);
      res.status(204).end();
    } catch (err) {
      handleError(res, err);
    }
  },
);

export default router;
