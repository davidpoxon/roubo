// REST surface for verify gates (#701, #703, FR-008, FR-012, FR-002, NFR-004;
// architecture.md "Gate API routes" row). Thin handlers in the testbench.ts mold:
// resolve the project repoPath, load the validated verify units (gates) via the
// work-unit-loader, apply the operator's recorded merge / split overrides as a
// pure transform (gate-overrides.ts), then evaluate each effective gate against
// its spec's recorded plan + results with the pure `evaluateGate` and return the
// projected GateState.
//
// Endpoints (mounted under /api/projects):
//   GET    /:projectId/gates            -> 200 { gates: GateState[], invalidSpecs: InvalidSpec[] }
//   GET    /:projectId/gates/:gateId    -> 200 GateState / 404 (unknown gate id)
//   POST   /:projectId/gates/merge      -> 200 (record a merge op) / 400 / 409
//   POST   /:projectId/gates/split      -> 200 (record a split op) / 400 / 409
//   POST   /:projectId/gates/:gateId/sign-off   -> 200 (close the gate's tracker
//                                                  issue) / 404 / 409 / 422
//   DELETE /:projectId/gates/:gateId/sign-off   -> 200 (reopen it) / 404 / 409
//   DELETE /:projectId/gates/overrides  -> 204 (reset all operator regroupings)
//
// Merge / split do NOT mutate the externally-authored work-units.json; they
// persist a Roubo-owned override document (gate-override-store.ts) applied as a
// pure transform at read time, so the effective (regrouped) gates are what the
// GET handlers return and evaluate.
//
// Results sourcing (architecture open question "Root-path resolution", #432): a
// gate is PROJECT-level, but the TestBench surface writes its observation marks
// under the focused bench's OWN worktree (bench.workspacePath, #493), not the
// project repoPath. So the plan + results are read from the worktree of a live
// TestBench focused on the gate's slug when one exists (resolveResultsRoot), and
// otherwise from the registered project's repoPath. Either way, when no
// plan/results exist at the resolved root yet, the gate reads as `stale`, never
// `passed` (NFR-007 fail-closed): an unverified gate must never look passable.

import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import { resolveFocusedSpec } from "../lib/testbench-spec-discovery.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import { WorkUnitsValidationError } from "../services/work-unit-loader.js";
import type { InvalidSpec, LoadedVerifyUnit } from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { GateOverrideStoreError } from "../services/gate-override-store.js";
import { applyGateOverrides } from "../lib/gate-overrides.js";
import type { WorkUnitCaseMap } from "../lib/gate-overrides.js";
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError, UnsafePathError } from "../lib/testbench-store.js";
import {
  resolveWithin,
  assertRealpathWithin,
  assertSafeIdentifier,
  SPEC_SLUG_RE,
} from "../lib/safe-path.js";
import { evaluateGate } from "../lib/gate-evaluator.js";
import type { GateState, VerifyUnit } from "../lib/gate-evaluator.js";
import type { Unit } from "@roubo/shared/work-units-contract";
import {
  validateGateOverrides,
  type GateOverrideOp,
  type GateOverridesFile,
} from "@roubo/shared/gate-overrides-contract";
import { EmptyNotesError, fileFixIssueAndBlock } from "../services/fix-issue-filer.js";
import { TrackerActionError, closeGate, reopenGate } from "../services/tracker-action-gateway.js";
import { resolveActivePlugin } from "../services/active-plugin.js";
import { isDone } from "../services/gate-lifecycle-coordinator.js";
import * as pluginManager from "../services/plugin-manager.js";
import type { NormalizedIssue } from "@roubo/shared";
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

// Write handlers (merge / split / reset / fix-issue filing) persist to disk and
// re-evaluate, so they are rate-limited too, on the same window with a tighter
// cap.
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
//
// It also stamps the gate's `milestone` (phase) from the loaded unit, so the
// Batches overview can title each card by phase rather than by bare gate id
// (issue #433). Null when the unit carries no milestone (e.g. a synthetic
// merged/split gate); the client then falls back to the gate id.
interface GateStateResponse extends GateState {
  gateId: string;
  milestone: string | null;
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
  // Filing a fix issue with empty notes is a validation failure (FR-009): 422
  // Unprocessable Entity, mirroring the capability-absent mapping below.
  if (err instanceof EmptyNotesError) {
    res.status(422).json({ error: err.message });
    return;
  }
  // A privileged tracker op was refused before it reached the plugin. The
  // architecture maps capability-absent to 422 (the gate cannot be wired through
  // this tracker); no-active-integration / not-consented are a 409 conflict (the
  // project is not in a state where the action can run).
  if (err instanceof TrackerActionError) {
    res.status(err.code === "capability-absent" ? 422 : 409).json({
      error: err.message,
      code: err.code,
    });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

// Resolve WHERE to read a gate's plan + results from for a given spec slug (#432).
//
// A gate is project-level, but the TestBench surface writes observation marks
// under the focused bench's own worktree (bench.workspacePath, #493), not the
// project repoPath. If a gate always read the project repo it would never see the
// operator's in-UI marks, and an all-passed batch would stay pending forever
// (issue #432). So when a live TestBench is focused on this gate's slug, read from
// that bench's worktree; otherwise fall back to the project repoPath.
//
// The fallback is fail-closed (NFR-007): a project with no focused TestBench (or a
// worktree that was later cleared) reads the project repo copy, which reads
// `stale` when no results exist there, never `passed`. Both the plan and the
// results are read from the SAME resolved root by the caller, so the
// planHash/freshness comparison stays self-consistent.
//
// When more than one TestBench focuses the same slug the first match wins. Benches
// are enumerated in insertion order, so this is deterministic; multiple benches on
// one slug is a rare operator configuration, and the first live worktree is a
// reasonable pick (the repoPath fallback still applies if it is later cleared).
function resolveResultsRoot(projectId: string, repoPath: string, slug: string): string {
  for (const bench of benchManager.getBenches(projectId)) {
    if (bench.variant !== "testbench") continue;
    const workspacePath = bench.workspacePath;
    if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) continue;
    if (bench.focusedSpecPath === undefined) continue;
    let benchSlug: string;
    try {
      benchSlug = resolveFocusedSpec(repoPath, bench.focusedSpecPath).slug;
    } catch {
      // A malformed / escaping focusedSpecPath just means this bench contributes
      // no results root; skip it rather than fail the whole gate read.
      continue;
    }
    if (benchSlug === slug) {
      return workspacePath;
    }
  }
  return repoPath;
}

// Evaluate a single loaded gate against its spec's recorded plan + results.
//
// The plan + results are read from the root resolved by `resolveResultsRoot`: the
// worktree of a TestBench focused on the gate's slug when one exists, else the
// project repoPath (#432). When the spec has no plan (or it is unreadable/invalid),
// `readPlanAndResults` throws MissingPlanError; per NFR-007 the gate is then read
// as `stale` with the gate's declared gating set unresolved, NEVER passed. When the
// plan exists, the pure `evaluateGate` decides: the plan is threaded in so the
// L3/L4 default-policy narrowing applies (FR-005, AC3).
function evaluateLoadedGate(
  projectId: string,
  repoPath: string,
  loaded: LoadedVerifyUnit,
): GateStateResponse {
  const { slug, unit } = loaded;
  const resultsRoot = resolveResultsRoot(projectId, repoPath, slug);

  let state: GateState;
  try {
    const { plan, results, planHash, stale } = testbenchStore.readPlanAndResults(resultsRoot, slug);
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
        gatingCaseIds: [...unresolvedCaseIds],
        coveringUnitIds: unresolvedCaseIds.length > 0 ? (unit.covers ?? []) : [],
      };
    } else {
      throw err;
    }
  }

  return { gateId: unit.id, milestone: unit.milestone ?? null, ...state };
}

// A gate response with the derived `signedOff` signal attached (issue #830).
// Source of truth is the gate's tracker-issue state, NOT a Roubo-owned marker.
type SignedOffGateStateResponse = GateStateResponse & { signedOff: boolean };

// The real filed gates whose tracker issues a sign-off / reopen / signed-off
// computation acts on (issue #435). A normally-loaded gate is its own single
// target (it carries its own tracker). An operator-merged gate has no filed issue
// of its own, so its targets are the source gates it was merged from, each with
// its real tracker ref: signing off the merged gate = closing every source issue,
// and it is signed off only when all of them are done.
function signOffTargets(loaded: LoadedVerifyUnit): readonly VerifyUnit[] {
  return loaded.mergedFrom ?? [loaded.unit];
}

// Derive the `signedOff` signal for a gate from its tracker-issue state and
// attach it to the projected response (issue #830, FR-007 AC). To bound plugin
// RPCs, only a `passed` gate is ever checked: a non-passed gate is signed-off =
// false by definition, and a gate with any target lacking a filed tracker issue
// (or no active integration) is likewise false. For a passed, fully-filed gate
// every target's tracker issue is fetched and `signedOff` is whether ALL of them
// are done (a merged gate is signed off only when every source issue is: issue
// #435). The `getIssue` RPC is fail-closed: a tracker hiccup yields
// `signedOff = false` rather than 500-ing a read (NFR-005, fail-closed: never
// report a gate as signed off on uncertain state).
async function withSignedOff(
  projectId: string,
  loaded: LoadedVerifyUnit,
  response: GateStateResponse,
): Promise<SignedOffGateStateResponse> {
  const targets = signOffTargets(loaded);
  const refs = targets.map((t) => t.tracker?.ref);
  if (response.status !== "passed" || refs.some((ref) => !ref)) {
    return { ...response, signedOff: false };
  }
  const active = resolveActivePlugin(projectId);
  if (!active) {
    return { ...response, signedOff: false };
  }
  try {
    const issues = await Promise.all(
      (refs as string[]).map((ref) =>
        pluginManager.invoke<NormalizedIssue>(active.pluginId, "getIssue", { externalId: ref }),
      ),
    );
    return { ...response, signedOff: issues.every((issue) => isDone(issue)) };
  } catch {
    return { ...response, signedOff: false };
  }
}

// The fully projected gate response the overview consumes: the signed-off gate
// state plus its derived upstream `blockedBy` list (issue #433, FR-001).
type ProjectedGateStateResponse = SignedOffGateStateResponse & { blockedBy: string[] };

// Derive each effective gate's upstream blockers: the ids of verify gates in the
// same spec that this gate's phase depends on and that are NOT yet signed off
// (issue #433, FR-001). Offline and deterministic: the dependency source is the
// LOCAL work-unit graph, computed from the gate's own `depends_on` plus the
// `depends_on` of each work unit the gate `covers` (no extra tracker RPCs). A
// candidate counts as an upstream blocker only when it is itself an effective
// gate on screen (so the overview can name a card) and its computed `signedOff`
// is false, so a signed-off upstream gate clears the block (AC2). Synthetic
// merged/split gates carry an empty `depends_on` and real covers, so they are
// tolerated (they derive blockers from their covers' deps, or none) and never
// throw. WU- ids are spec-scoped in practice, so blockers are matched within the
// gate's own slug (mirrors buildCaseMap's last-write-wins caveat).
function deriveBlockedBy(
  repoPath: string,
  gates: readonly LoadedVerifyUnit[],
  signedOffById: ReadonlyMap<string, boolean>,
): Map<string, string[]> {
  // The effective gate ids present per slug: an upstream blocker must be one of
  // them (a gate whose sign-off state we know and can render).
  const gateIdsBySlug = new Map<string, Set<string>>();
  for (const { slug, unit } of gates) {
    let set = gateIdsBySlug.get(slug);
    if (set === undefined) {
      set = new Set<string>();
      gateIdsBySlug.set(slug, set);
    }
    set.add(unit.id);
  }

  // Build each spec's unit graph (id -> unit) once, lazily, so a covered unit's
  // deps can be read. loadAllUnitsForSlug returns [] for an absent file
  // (fail-open) and throws only on a present-but-invalid artifact, which the gate
  // load has already surfaced for the same slug.
  const graphBySlug = new Map<string, Map<string, Unit>>();
  const graphFor = (slug: string): Map<string, Unit> => {
    let graph = graphBySlug.get(slug);
    if (graph === undefined) {
      // Fail-open: blockedBy is advisory observability, not a gate decision. A slug
      // whose full unit graph cannot be read here (it was valid when its gates
      // loaded, so a throw is exceptional) degrades to deriving blockedBy from each
      // gate's own depends_on rather than 500-ing the whole overview.
      let units: Unit[];
      try {
        units = workUnitLoader.loadAllUnitsForSlug(repoPath, slug);
      } catch {
        units = [];
      }
      graph = new Map(units.map((u) => [u.id, u]));
      graphBySlug.set(slug, graph);
    }
    return graph;
  };

  const result = new Map<string, string[]>();
  for (const { slug, unit } of gates) {
    const graph = graphFor(slug);
    const gateIds = gateIdsBySlug.get(slug) ?? new Set<string>();
    // Candidate upstream ids: the gate's own deps plus each covered unit's deps.
    const candidates = new Set<string>(unit.depends_on);
    for (const coverId of unit.covers ?? []) {
      const covered = graph.get(coverId);
      if (covered) {
        for (const dep of covered.depends_on) candidates.add(dep);
      }
    }
    candidates.delete(unit.id);
    const blockedBy = [...candidates]
      .filter((id) => gateIds.has(id) && signedOffById.get(id) === false)
      .sort();
    result.set(unit.id, blockedBy);
  }
  return result;
}

// Project a set of effective gates into the overview response shape: evaluate
// each, attach its `signedOff` signal, then derive each gate's upstream
// `blockedBy` from the whole set's sign-off state (issue #433). Shared by the two
// GET handlers and the merge / split re-projection so every gate response carries
// the same fields (milestone + gatingCaseIds + blockedBy). The single-gate GET
// still projects the whole set so the requested gate's upstream sign-off state is
// known.
async function projectGates(
  projectId: string,
  repoPath: string,
  gates: readonly LoadedVerifyUnit[],
): Promise<ProjectedGateStateResponse[]> {
  const signed = await Promise.all(
    gates.map((loaded) =>
      withSignedOff(projectId, loaded, evaluateLoadedGate(projectId, repoPath, loaded)),
    ),
  );
  const signedOffById = new Map(signed.map((g) => [g.gateId, g.signedOff]));
  const blockedByById = deriveBlockedBy(repoPath, gates, signedOffById);
  return signed.map((g) => ({ ...g, blockedBy: blockedByById.get(g.gateId) ?? [] }));
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
// the effective (regrouped) loaded gates plus the specs whose work-units.json was
// present-but-invalid (skipped, not aborting the load: #371, #802). Centralised so
// the GET handlers and the write handlers' guard share the exact same effective
// view. Operator overrides regroup only the valid gates; they never touch
// `invalidSpecs` (a skipped spec has no gates to merge or split).
//
// When `slug` is given the load is scoped to that single spec's work-units.json
// (issue #549: the Batches overview must show only the bench's focused spec, the
// way the Cases tab already does, instead of aggregating every spec project-wide);
// when omitted the load enumerates every spec (the backward-compatible all-specs
// behaviour). Operator overrides are project-keyed and stay so: `applyGateOverrides`
// finds no source gates for other specs' ids, so a single-spec loaded set is inert
// for any override targeting another spec.
function effectiveGates(
  repoPath: string,
  projectId: string,
  slug?: string,
): { gates: LoadedVerifyUnit[]; invalidSpecs: InvalidSpec[] } {
  const { loaded, invalidSpecs } = workUnitLoader.loadVerifyUnitsWithDiagnostics(repoPath, slug);
  const overrides = gateOverrideStore.loadOverrides(projectId);
  const caseMap = buildCaseMap(repoPath, loaded);
  return { gates: applyGateOverrides(loaded, overrides, caseMap).gates, invalidSpecs };
}

// Parse the optional `?slug=` query param that scopes the gates list to a single
// focused spec (issue #549). Absent -> undefined (the all-specs behaviour). When
// present it MUST be a single string that passes the spec-slug allowlist: the
// single-slug loader path (loadVerifyUnitsForSlug) skips the per-entry
// assertSafeIdentifier guard the all-specs enumeration applies, so a traversal /
// separator-bearing slug has to be rejected HERE, at the HTTP boundary, before it
// reaches the loader. A non-string (e.g. a repeated `?slug=a&slug=b` array) is a
// 400 RouteError; an unsafe string throws UnsafePathError, which handleError also
// maps to a 400.
function parseSlugQuery(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new RouteError(400, "slug query param must be a single string");
  }
  assertSafeIdentifier(raw, SPEC_SLUG_RE, "spec slug");
  return raw;
}

// GET /:projectId/gates -> 200 { gates: GateState[]; invalidSpecs: InvalidSpec[] }.
// An optional `?slug=` query param scopes the response to a single focused spec's
// gates (issue #549), so a TestBench Batches tab shows only its bench's focused
// spec (matching the Cases tab) instead of every spec's gates project-wide. Absent
// -> the backward-compatible all-specs behaviour. `gates` has one entry per
// effective gate in scope (an empty array is a valid, normal response: no gates
// yet). `invalidSpecs` names any spec whose work-units.json was present-but-invalid
// and skipped (#371), so the client can surface a warning instead of an
// indistinguishable empty state. A genuinely empty project returns both empty.
router.get(
  "/:projectId/gates",
  gateReadRateLimiter,
  async (
    req: Request<{ projectId: string }, unknown, unknown, { slug?: unknown }>,
    res: Response,
  ) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const slug = parseSlugQuery(req.query.slug);
      const { gates, invalidSpecs } = effectiveGates(repoPath, req.params.projectId, slug);
      const states = await projectGates(req.params.projectId, repoPath, gates);
      res.json({ gates: states, invalidSpecs });
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
  async (req: Request<{ projectId: string; gateId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const { gates } = effectiveGates(repoPath, req.params.projectId);
      // Project the whole effective set (not just the requested gate) so this
      // gate's upstream `blockedBy` reflects its siblings' sign-off state (#433).
      const states = await projectGates(req.params.projectId, repoPath, gates);
      const state = states.find((g) => g.gateId === req.params.gateId);
      if (state === undefined) {
        throw new RouteError(404, `Gate '${req.params.gateId}' not found`);
      }
      res.json(state);
    } catch (err) {
      handleError(res, err);
    }
  },
);

// Guard (AC3): merge / split is prevented when any gate it involves currently
// evaluates to `passed` (a passed gate is sign-off-eligible; its tracker issue
// may already be closed via the sign-off route, issue #830). Throws a 409
// RouteError with a clear message; the operator must reopen it first.
function assertNoneSignedOff(
  projectId: string,
  repoPath: string,
  effective: readonly LoadedVerifyUnit[],
  gateIds: readonly string[],
): void {
  for (const gateId of gateIds) {
    const loaded = effective.find((g) => g.unit.id === gateId);
    if (loaded === undefined) {
      throw new RouteError(400, `Gate '${gateId}' not found`);
    }
    const state = evaluateLoadedGate(projectId, repoPath, loaded);
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
async function recordOp(
  repoPath: string,
  projectId: string,
  op: GateOverrideOp,
  res: Response,
): Promise<void> {
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
  const states = await projectGates(projectId, repoPath, applied.gates);
  res.json(states);
}

// POST /:projectId/gates/merge { gateIds } -> 200 GateState[] (the recomputed
// effective list) / 400 (unknown id, cross-slug) / 409 (a signed-off gate).
router.post(
  "/:projectId/gates/merge",
  gateWriteRateLimiter,
  async (req: Request<{ projectId: string }>, res: Response) => {
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
      const { gates: effective } = effectiveGates(repoPath, req.params.projectId);
      assertNoneSignedOff(req.params.projectId, repoPath, effective, gateIds);
      await recordOp(repoPath, req.params.projectId, { op: "merge", gateIds }, res);
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
  async (req: Request<{ projectId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const { gateId, parts } = req.body ?? {};
      if (typeof gateId !== "string" || !Array.isArray(parts) || parts.length < 2) {
        throw new RouteError(400, "split requires a gateId and at least two parts");
      }
      const { gates: effective } = effectiveGates(repoPath, req.params.projectId);
      assertNoneSignedOff(req.params.projectId, repoPath, effective, [gateId]);
      await recordOp(repoPath, req.params.projectId, { op: "split", gateId, parts }, res);
    } catch (err) {
      handleError(res, err);
    }
  },
);

// Parse the "owner/repo" prefix from a GitHub-style tracker ref ("owner/repo#N").
// The created fix issue is filed in the same repo as the gate it blocks; the
// gateway's createIssue takes a repoFullName, so derive it from the gate's ref.
// Returns null when the ref is not in the owner/repo#number shape.
function repoFullNameFromRef(ref: string): string | null {
  const match = /^([^#\s]+\/[^#\s]+)#\d+$/.exec(ref);
  return match ? match[1] : null;
}

// Write the verifier's optional evidence artifact, path-confined to the gate's
// spec folder (NFR-001, TC-049). The evidence value is a caller-supplied relative
// path. The spec folder `.specifications/<slug>/` is resolved as the fixed
// confinement root FIRST (slug re-validated through SPEC_SLUG_RE), then the
// evidence path is joined under it with a SECOND resolveWithin so any traversal
// (e.g. "../../outside-workspace/secrets.txt") escapes the slug folder and throws
// UnsafePathError before any fs call. Confining to the slug folder (not the repo
// root) is the tighter boundary: a couple of `../` segments must not let an
// evidence write land elsewhere in the repo, let alone outside it.
//
// resolveWithin is lexical, so it cannot see an on-disk symlink whose name is a
// valid slug. assertRealpathWithin is the SECOND barrier at the sink (mirrors
// writeResults, #416/#427): it realpaths the deepest existing ancestor of the
// evidence dir and re-asserts containment against the realpath'd repoPath,
// rejecting a symlinked `.specifications/<slug>` that escapes the repo. Unlike
// writeResults (whose dir is the fixed, already-existing slug folder), `evidence`
// is a caller-supplied relative path that may add subdirectories, so the barrier
// MUST run BEFORE mkdirSync: a recursive mkdir follows a symlinked slug and would
// create a directory OUTSIDE repoPath before the check could fire. realpath-
// DeepestExisting handles the not-yet-created tail by walking up to the nearest
// existing ancestor, so the check is valid even though the dir does not exist yet.
function writeEvidence(repoPath: string, slug: string, evidence: string, notes: string): void {
  assertSafeIdentifier(slug, SPEC_SLUG_RE, "spec slug");
  const specDir = resolveWithin(repoPath, ".specifications", slug);
  const target = resolveWithin(specDir, evidence);
  const dir = path.dirname(target);
  assertRealpathWithin(repoPath, dir, "evidence dir");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, notes, "utf8");
}

// POST /:projectId/gates/:gateId/fix-issues -> file a fix issue for a failed
// gating case and wire it to block the gate (FR-009, FR-010, NFR-003; #706).
//
// Body: { failedCaseId, notes, evidence?, existingFixRef? }. Empty notes -> 422.
// An evidence path that escapes the workspace -> 400 (UnsafePathError). On
// success the verifier's notes are appended to the gate's recorded results
// (path-confined via testbench-store), then the filer creates the issue and
// registers the block-link. Status mapping mirrors the architecture:
//   201 complete / 207 link_pending / 422 capability-absent (or empty notes) /
//   409 (no active integration / not consented).
router.post(
  "/:projectId/gates/:gateId/fix-issues",
  gateWriteRateLimiter,
  async (req: Request<{ projectId: string; gateId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const { gates } = effectiveGates(repoPath, req.params.projectId);
      const loaded = gates.find((g) => g.unit.id === req.params.gateId);
      if (loaded === undefined) {
        throw new RouteError(404, `Gate '${req.params.gateId}' not found`);
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const { failedCaseId, notes, evidence, existingFixRef } = body;
      if (typeof failedCaseId !== "string" || failedCaseId.length === 0) {
        throw new RouteError(400, "fix-issue filing requires a non-empty failedCaseId");
      }
      if (typeof notes !== "string") {
        throw new RouteError(400, "fix-issue filing requires a notes string");
      }
      if (evidence !== undefined && typeof evidence !== "string") {
        throw new RouteError(400, "evidence must be a string path when present");
      }
      if (existingFixRef !== undefined && typeof existingFixRef !== "string") {
        throw new RouteError(400, "existingFixRef must be a string when present");
      }

      // The gate's block targets must EACH carry a tracker ref to be blockable: a
      // normally-loaded gate blocks its own issue; a merged/split synthetic gate
      // has no filed issue of its own, so it blocks its source gate(s)' issues
      // (issue #435 for merges, issue #445 for splits). One fix issue blocks every
      // target (mirroring "sign-off closes every source"). A target with no filed
      // tracker issue has no block target, so degrade loudly (FR-011) rather than a
      // silent no-op; guard before filing so a partly-tracked merge never files an
      // issue that can only block some sources.
      const targets = signOffTargets(loaded);
      const untracked = targets.filter((t) => !t.tracker?.ref);
      if (untracked.length > 0) {
        throw new RouteError(
          409,
          loaded.mergedFrom
            ? `Gate '${req.params.gateId}' cannot be blocked by a fix issue: source gate(s) ${untracked
                .map((t) => t.id)
                .join(", ")} have no tracker issue.`
            : `Gate '${req.params.gateId}' has no tracker issue, so a fix issue cannot be wired to block it.`,
        );
      }
      const targetRefs = targets.flatMap((t) => (t.tracker?.ref ? [t.tracker.ref] : []));
      const [gateRef, ...additionalGateRefs] = targetRefs;
      const repoFullName = repoFullNameFromRef(gateRef);
      if (repoFullName === null) {
        throw new RouteError(
          409,
          `Gate '${req.params.gateId}' tracker ref '${gateRef}' is not a 'owner/repo#number' GitHub ref, so a fix issue cannot be filed for it.`,
        );
      }

      // Reject empty notes BEFORE any write or tracker call (TC-053). The filer
      // also guards this; checking here keeps the path-confined write below from
      // running for an empty-notes request.
      if (notes.trim().length === 0) {
        throw new EmptyNotesError(
          "Fix issue notes must not be empty: enter a description of the failure before filing.",
        );
      }

      // Persist the verifier's notes, path-confined to the gate's spec folder
      // (NFR-001). The optional evidence artifact is written through the
      // resolveWithin barrier (TC-049): a path-escaping value throws here, before
      // any tracker call, so no issue is created for a rejected write. On a
      // link-only retry (existingFixRef set) the notes were already captured on
      // the first attempt, so skip the append: the retry runs only the link step.
      const isLinkOnlyRetry = typeof existingFixRef === "string" && existingFixRef.length > 0;
      if (!isLinkOnlyRetry) {
        if (evidence !== undefined && evidence.length > 0) {
          writeEvidence(repoPath, loaded.slug, evidence, notes);
        }
        await testbenchStore.appendNote(repoPath, loaded.slug, failedCaseId, notes);
      }

      const record = await fileFixIssueAndBlock(req.params.projectId, {
        repoFullName,
        failedCaseId,
        gateRef,
        ...(additionalGateRefs.length > 0 ? { additionalGateRefs } : {}),
        notes,
        ...(existingFixRef ? { existingFixRef } : {}),
      });

      res.status(record.linkStatus === "complete" ? 201 : 207).json(record);
    } catch (err) {
      handleError(res, err);
    }
  },
);

// POST /:projectId/gates/:gateId/sign-off -> sign off a passed batch by closing
// the gate's tracker issue through the active integration plugin (issue #830,
// FR-007/FR-008, US-005, NFR-001). Returns the updated GateState with
// `signedOff: true`.
//
// Fail-closed (AC): the close runs ONLY when the gate's evaluated status is
// `passed`; any other status is a 409 (the guard is load-bearing server-side,
// not just a disabled button). When the gate has no filed tracker issue the
// request degrades loudly with a 409 rather than a silent no-op that appears to
// succeed (FR-011, NFR-005). The privileged close is audit-logged by the
// gateway. TrackerActionError from the gateway maps via handleError (422
// capability-absent, 409 no-active-integration / not-consented).
router.post(
  "/:projectId/gates/:gateId/sign-off",
  gateWriteRateLimiter,
  async (req: Request<{ projectId: string; gateId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const { gates } = effectiveGates(repoPath, req.params.projectId);
      const loaded = gates.find((g) => g.unit.id === req.params.gateId);
      if (loaded === undefined) {
        throw new RouteError(404, `Gate '${req.params.gateId}' not found`);
      }

      // Fail-closed guard: refuse sign-off unless the gate's evaluated status is
      // passed. This is the load-bearing rejection, not just the disabled button.
      const state = evaluateLoadedGate(req.params.projectId, repoPath, loaded);
      if (state.status !== "passed") {
        throw new RouteError(
          409,
          `Gate '${req.params.gateId}' cannot be signed off: its status is '${state.status}', not 'passed'. Resolve every gating case first.`,
        );
      }

      // Sign-off closes each target's tracker issue. A normal gate has one target
      // (itself); a merged gate fans out over its source gates, each carrying its
      // own filed issue (issue #435). A target with no filed tracker issue has no
      // close target, so degrade loudly (FR-011) rather than a silent no-op that
      // would appear to succeed. Guarding before any close keeps a partly-filed
      // merge from closing some source issues before hitting the missing one.
      const targets = signOffTargets(loaded);
      const untracked = targets.filter((t) => !t.tracker?.ref);
      if (untracked.length > 0) {
        throw new RouteError(
          409,
          loaded.mergedFrom
            ? `Gate '${req.params.gateId}' cannot be signed off: source gate(s) ${untracked
                .map((t) => t.id)
                .join(", ")} have no tracker issue.`
            : `Gate '${req.params.gateId}' has no tracker issue, so it cannot be signed off.`,
        );
      }

      // Close each source issue in turn. Not atomic: a mid-loop plugin rejection
      // (TrackerActionError) propagates via handleError, leaving earlier sources
      // closed (partial progress), mirroring the single-gate 500/409-on-rejection.
      for (const target of targets) {
        await closeGate(req.params.projectId, target);
      }
      // Re-project the whole effective set so the response carries the updated
      // signedOff plus milestone / gatingCaseIds / blockedBy (issue #433).
      const states = await projectGates(req.params.projectId, repoPath, gates);
      res.json(states.find((g) => g.gateId === req.params.gateId));
    } catch (err) {
      handleError(res, err);
    }
  },
);

// DELETE /:projectId/gates/:gateId/sign-off -> reopen a signed-off gate by
// reopening its tracker issue through the active integration plugin (issue #830,
// US-005). Returns the updated GateState with `signedOff: false`. Reopen does
// NOT require status === passed (a signed-off gate whose plan later changed may
// no longer evaluate passed yet must still be reopenable). When the gate has no
// filed tracker issue the request degrades loudly with a 409.
router.delete(
  "/:projectId/gates/:gateId/sign-off",
  gateWriteRateLimiter,
  async (req: Request<{ projectId: string; gateId: string }>, res: Response) => {
    try {
      const repoPath = resolveRepoPath(req.params.projectId);
      const { gates } = effectiveGates(repoPath, req.params.projectId);
      const loaded = gates.find((g) => g.unit.id === req.params.gateId);
      if (loaded === undefined) {
        throw new RouteError(404, `Gate '${req.params.gateId}' not found`);
      }

      // Reopen mirrors sign-off: a normal gate reopens its own issue; a merged gate
      // fans out over its source gates' issues (issue #435). A target with no filed
      // tracker issue degrades loudly rather than silently no-op'ing.
      const targets = signOffTargets(loaded);
      const untracked = targets.filter((t) => !t.tracker?.ref);
      if (untracked.length > 0) {
        throw new RouteError(
          409,
          loaded.mergedFrom
            ? `Gate '${req.params.gateId}' cannot be reopened: source gate(s) ${untracked
                .map((t) => t.id)
                .join(", ")} have no tracker issue.`
            : `Gate '${req.params.gateId}' has no tracker issue, so it cannot be reopened.`,
        );
      }

      for (const target of targets) {
        await reopenGate(req.params.projectId, target);
      }
      // Re-project the whole effective set so the response carries the updated
      // signedOff plus milestone / gatingCaseIds / blockedBy (issue #433).
      const states = await projectGates(req.params.projectId, repoPath, gates);
      res.json(states.find((g) => g.gateId === req.params.gateId));
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
