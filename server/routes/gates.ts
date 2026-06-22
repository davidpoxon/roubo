// REST surface for verify gates (#701, FR-008, FR-012, NFR-004; architecture.md
// "Gate API routes" row). Thin handlers in the testbench.ts mold: resolve the
// project repoPath, load the validated verify units (gates) via the
// work-unit-loader, evaluate each against its spec's recorded plan + results with
// the pure `evaluateGate`, and return the projected GateState.
//
// Endpoints (mounted under /api/projects):
//   GET /:projectId/gates            -> 200 GateState[] (one per verify unit)
//   GET /:projectId/gates/:gateId    -> 200 GateState / 404 (unknown gate id)
//
// Out of scope here (later phases / issues): POST /gates/:gateId/fix-issues
// (FR-009/010/011, Phase 4), client UI, merge/split.
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
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError, UnsafePathError } from "../lib/testbench-store.js";
import { evaluateGate } from "../lib/gate-evaluator.js";
import type { GateState } from "../lib/gate-evaluator.js";
import { RouteError } from "./helpers.js";

const router = Router();

// Both gate handlers resolve a project (authorization) and then read plan/results
// files from disk per gate, so they are rate-limited to mitigate denial-of-service
// (CodeQL js/missing-rate-limiting, alerts 186/187). Mirrors the limiter used by the sibling
// routers (benches-settings.ts, projects.ts).
const gateReadRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
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
// WorkUnitsValidationError is a present-but-broken artifact (400), and everything
// else is a 500. A MissingPlanError never escapes a handler (it is caught per
// gate and folded into a stale state), so it is not mapped here.
function handleError(res: import("express").Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  if (err instanceof WorkUnitsValidationError) {
    res.status(400).json({ error: err.message, errors: err.errors });
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

// GET /:projectId/gates -> 200 GateState[] (one per verify unit across the
// project's specs). An empty array is a valid, normal response (no gates yet).
router.get(
  "/:projectId/gates",
  gateReadRateLimiter,
  (req: Request<{ projectId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const gates = workUnitLoader.loadVerifyUnits(repoPath);
      res.json(gates.map((loaded) => evaluateLoadedGate(repoPath, loaded)));
    } catch (err) {
      handleError(res, err);
    }
  },
);

// GET /:projectId/gates/:gateId -> 200 GateState / 404 when no verify unit has
// that id. For a non-passed gate the payload carries the unresolved TC- ids and
// the covering slice unit ids (FR-012, NFR-004).
router.get(
  "/:projectId/gates/:gateId",
  gateReadRateLimiter,
  (req: Request<{ projectId: string; gateId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const gates = workUnitLoader.loadVerifyUnits(repoPath);
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

export default router;
