// REST surface for the TestBench (#459). Thin handlers
// that resolve the project repoPath + bench, validate request bodies with the
// testbench-contracts zod schemas, derive the spec slug from the bench's
// focusedSpecPath, then delegate every filesystem write to testbench-store (which
// resolves git identity and enforces NFR-001/NFR-003 internally). The route layer
// never touches the filesystem directly.
//
// Endpoints (all under /api/projects):
//   GET    /:projectId/testbench/specs
//   POST   /:projectId/testbench/specs/validate
//   PUT    /:projectId/testbench/specs/:slug/lifecycle
//   GET    /:projectId/benches/:id/testbench/plan
//   GET    /:projectId/benches/:id/testbench/replacement-candidates
//   PUT    /:projectId/benches/:id/testbench/cases/:caseId/observations/:observationId
//   PUT    /:projectId/benches/:id/testbench/cases/:caseId/status
//   PUT    /:projectId/benches/:id/testbench/cases/:caseId/lifecycle
//   POST   /:projectId/benches/:id/testbench/cases/:caseId/notes
//   POST   /:projectId/benches/:id/testbench/cases/:caseId/stage
//   POST   /:projectId/benches/:id/testbench/reconcile
//   PUT    /:projectId/benches/:id/testbench/focus
//
// The TestBench create endpoint (POST /:projectId/benches { variant }) lives in
// benches.ts: it is the normal bench-manager create path.

import express, { Router, type Request, type RequestHandler, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import * as benchManager from "../services/bench-manager.js";
import { BenchError } from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as testbenchStore from "../lib/testbench-store.js";
import {
  CaseLifecycleConflictError,
  CaseNotFoundError,
  MissingCaseFileError,
  MissingPlanError,
  UnsafePathError,
} from "../lib/testbench-store.js";
import {
  computeLifecycle,
  discoverSpecs,
  validateManualPath,
} from "../lib/testbench-spec-discovery.js";
import {
  getTestbenchHostProvider,
  resolveTestbenchHost,
  resolveTestbenchMarkHost,
  type TestbenchHostRefusal,
} from "../services/testbench-host-resolver.js";
import {
  CASE_STATUS_BODY_LIMIT,
  InvalidEvidenceError,
  caseEvidenceNoteText,
  decodeCaseScreenshot,
  writeCaseScreenshot,
  type CaseScreenshot,
} from "../lib/case-evidence.js";
import {
  ManifestUnreadableError,
  SpecFolderNotFoundError,
  writeSpecLifecycle,
} from "../lib/testbench-spec-lifecycle-write.js";
import { RouteError, parseIntParam } from "./helpers.js";
import { CaseLifecycleSchema, CaseStatusSchema } from "@roubo/shared/testbench-contracts";
import type { Case } from "@roubo/shared/testbench-contracts";
import {
  MAX_SUPERSESSION_DEPTH,
  collectReferencedSlugs,
  type ResolverPlan,
} from "@roubo/shared/lifecycle-resolver";
import { SpecLifecycleRecordSchema } from "@roubo/shared/spec-lifecycle-schema";
import * as workUnitLoader from "../services/work-unit-loader.js";
import * as gateOverrideStore from "../services/gate-override-store.js";
import { GateOverrideStoreError } from "../services/gate-override-store.js";
import { applyGateOverrides } from "../lib/gate-overrides.js";
import {
  StateRecipeCommitMismatchError,
  StateRecipeInvalidError,
  StateRecipeNotFoundError,
  UnknownStateRecipeStepError,
  stageCaseFromRecipe,
} from "../services/state-recipe-replay.js";

const router = Router();

// The plan endpoint resolves a project/bench (authorization) and then reads the
// plan + results from disk, and on a ?gateIds= filter also loads the bench's
// work-units, so it is rate-limited to mitigate denial-of-service (CodeQL
// js/missing-rate-limiting, alert 188). The client refetches the plan after
// every mark, note and reconcile, so the cap sits well above what one person can
// trigger through the UI; at 30 a quick marking session got 429s (#1473). Same
// read cap as gates.ts.
const planReadRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

// Request-body schemas (testbench-contracts-aligned). Each is strict so an
// unexpected key is a 400 rather than silently ignored.
const ValidatePathBodySchema = z.object({ path: z.string() }).strict();
// result is pass | fail to set a mark, or null to clear (un-set) it (#510).
const MarkObservationBodySchema = z
  .object({ result: z.enum(["pass", "fail"]).nullable() })
  .strict();
// The optional evidence of a mark (SB-FR-027): a note, a screenshot as a base64
// image data URL, or both. The screenshot is written under the spec folder's
// `evidence/<caseId>/`, and the note, with the screenshot's path, is appended to
// the case's notes.
const MarkEvidenceSchema = z
  .object({ note: z.string().optional(), screenshot: z.string().optional() })
  .strict();
const SetStatusBodySchema = z
  .object({ override: CaseStatusSchema.nullable(), evidence: MarkEvidenceSchema.optional() })
  .strict();
// The lifecycle record to write, or null to restore (#1167). The record is
// wrapped in a `{ lifecycle }` envelope rather than sent bare: express.json runs
// in body-parser's default strict mode, which accepts only objects and arrays, so
// a literal `null` body (the shape architecture.md sketches) never reaches a
// handler at all. The envelope matches the sibling `{ override: ... | null }`
// endpoint above and keeps restore expressible. The contract's discriminated
// union does the validating, so a missing reason, a missing replacement, or an
// unknown state is a 400 with a field-named message.
const SetCaseLifecycleBodySchema = z
  .object({ lifecycle: z.union([CaseLifecycleSchema, z.null()]) })
  .strict();
const AppendNoteBodySchema = z.object({ text: z.string() }).strict();
const ReconcileBodySchema = z
  .object({ confirm: z.boolean().optional(), purgeOrphans: z.boolean().optional() })
  .strict();
const FocusBodySchema = z.object({ focusedSpecPath: z.string() }).strict();
// Spec lifecycle write (#1166, SATCA-FR-020/FR-021). The record is the published
// SpecLifecycleRecordSchema verbatim, so the route can never accept a shape the
// reader would later reject. It is NESTED under a `lifecycle` key rather than
// sent as the bare body because `null` (the reversal) is the payload for
// restoring a spec, and express.json() runs in strict mode: a top-level `null`
// body never reaches the handler.
const SpecLifecycleBodySchema = z
  .object({ lifecycle: SpecLifecycleRecordSchema.nullable() })
  .strict();

// Resolve a registered project's repoPath, or throw a 404 RouteError. Centralised
// so every handler resolves it the same way.
function resolveRepoPath(projectId: string): string {
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.config) {
    throw new RouteError(404, `Project '${projectId}' not found`);
  }
  return project.repoPath;
}

// The path of the case status route, under the server's /api/projects mount.
export const TESTBENCH_CASE_STATUS_PATH =
  "/api/projects/:projectId/benches/:id/testbench/cases/:caseId/status";

const caseStatusJson = express.json({ limit: CASE_STATUS_BODY_LIMIT });

// The JSON parser of the case status route, whose body can carry a screenshot
// over the global limit. The server mounts it on that path before its global
// parser, which then finds the body read and skips it.
export const testbenchCaseStatusBodyParser: RequestHandler = (req, res, next) => {
  void caseStatusJson(req, res, (error?: unknown) => {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { type?: unknown }).type === "entity.too.large"
    ) {
      res.status(413).json({
        error: `A case status body holds at most ${CASE_STATUS_BODY_LIMIT}`,
        code: "PAYLOAD_TOO_LARGE",
      });
      return;
    }
    next(error);
  });
};

// A refusal of the TestbenchHostResolver, sent with its status, code and
// blocking classes.
class HostRefusalError extends Error {
  constructor(readonly refusal: TestbenchHostRefusal) {
    super(refusal.error);
  }
}

// Resolve a TestBench and derive the (rootPath, slug) tuple the store needs,
// through the TestbenchHostResolver port. For the TestBench variant `rootPath` is
// the bench's own worktree (#494): the plan and the results sidecar are both read
// and written under `bench.workspacePath/.specifications/<slug>/`, not the
// registered project repoPath. The slug is still resolved against the project
// repoPath, where the focused spec path was picked and validated.
//
// Throws RouteError(404) when the bench is missing, RouteError(400) when the
// bench's variant hosts no TestBench / it has no focused spec, the focused path
// is malformed, or the bench has no usable workspace path (an error-state bench
// must not write to a bogus root).
function resolveTestbench(
  projectId: string,
  benchId: number,
  purpose: "read",
): { rootPath: string; slug: string } {
  const repoPath = resolveRepoPath(projectId);
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    throw new RouteError(404, "Bench not found");
  }
  const resolved = resolveTestbenchHost(bench, purpose, repoPath);
  if (!resolved.ok) {
    throw new HostRefusalError(resolved);
  }
  return { rootPath: resolved.host.rootPath, slug: resolved.host.slug };
}

// Resolve a TestBench for a write: as resolveTestbench, then the mark check of
// the bench variant's provider, which can refuse with a 400 or a 409 (a Spec
// Bench with no sitting open, or under a blocking cross-check class).
async function resolveTestbenchForMark(
  projectId: string,
  benchId: number,
): Promise<{ bench: import("@roubo/shared").Bench; rootPath: string; slug: string }> {
  const repoPath = resolveRepoPath(projectId);
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    throw new RouteError(404, "Bench not found");
  }
  const resolved = await resolveTestbenchMarkHost(bench, repoPath);
  if (!resolved.ok) {
    throw new HostRefusalError(resolved);
  }
  return { bench, rootPath: resolved.host.rootPath, slug: resolved.host.slug };
}

// Map any thrown error to an HTTP response: RouteError /
// BenchError carry a statusCode, MissingPlanError -> 404, UnsafePathError -> 400,
// everything else -> 500.
function handleError(res: import("express").Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  if (err instanceof HostRefusalError) {
    const { status, error, code, classes } = err.refusal;
    res.status(status).json({
      error,
      ...(code !== undefined && { code }),
      ...(classes !== undefined && { classes }),
    });
    return;
  }
  if (err instanceof InvalidEvidenceError) {
    res.status(400).json({ error: err.message, code: "INVALID_EVIDENCE" });
    return;
  }
  if (err instanceof BenchError) {
    const status =
      err.code === "NOT_FOUND" || err.code === "PROJECT_NOT_FOUND"
        ? 404
        : err.code === "NO_BENCHES" || err.code === "GLOBAL_CAP_REACHED"
          ? 409
          : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof MissingPlanError) {
    res.status(404).json({ error: err.message });
    return;
  }
  // Lifecycle writes (#1167): an absent/invalid case file or an unknown case id is
  // a 404, and a case file that changed under the request is a 409 carrying the
  // fingerprint the file actually holds now, so the client can say "reload".
  if (err instanceof MissingCaseFileError || err instanceof CaseNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof CaseLifecycleConflictError) {
    res.status(409).json({
      error: err.message,
      code: "case-file-conflict",
      caseFileFingerprint: err.actualFingerprint,
    });
    return;
  }
  if (err instanceof UnsafePathError) {
    res.status(400).json({ error: err.message });
    return;
  }
  // Staging a case from its state recipe (SB-FR-025): no recipe is a 404 the
  // client reads as "the case opened cold", a recipe at another commit than the
  // pin (or no pin at all) a 409 naming the pin commit, and a recipe that does
  // not validate, or names a step kind the replayer does not run, a 400.
  if (err instanceof StateRecipeNotFoundError) {
    res.status(404).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof StateRecipeCommitMismatchError) {
    res.status(409).json({
      error: err.message,
      code: err.code,
      ...(err.pinCommit !== undefined && { pinCommit: err.pinCommit }),
      ...(err.recipeCommit !== undefined && { recipeCommit: err.recipeCommit }),
    });
    return;
  }
  if (err instanceof StateRecipeInvalidError) {
    res.status(400).json({ error: err.message, code: err.code, errors: err.errors });
    return;
  }
  if (err instanceof UnknownStateRecipeStepError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  // Lifecycle-write failures (#1166). A spec folder that is not there is a 404,
  // exactly like a missing plan. A manifest the writer refused to clobber is a
  // 409: the request was well-formed and it is the on-disk state that blocks it,
  // so the reviewer needs to go fix the file rather than resend.
  if (err instanceof SpecFolderNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ManifestUnreadableError) {
    res.status(409).json({ error: err.message });
    return;
  }
  // A present-but-broken work-units.json in the ?gateIds= subset path is a
  // bad-request-shaped misconfiguration, not a 500.
  if (err instanceof workUnitLoader.WorkUnitsValidationError) {
    res.status(400).json({ error: err.message, errors: err.errors });
    return;
  }
  // A corrupt / invalid persisted gate-overrides document (loaded in the
  // ?gateIds= subset path) is likewise bad-request-shaped, not a 500. Mirrors the
  // sibling gates.ts handler: INVALID_PROJECT_ID / PARSE / SCHEMA all map to 400.
  if (err instanceof GateOverrideStoreError) {
    res.status(400).json({ error: err.message, code: err.code, errors: err.errors });
    return;
  }
  res.status(500).json({ error: (err as Error).message });
}

// 1. Discover specs: enumerate + validate .specifications/*/test-cases.json.
router.get("/:projectId/testbench/specs", (req, res) => {
  try {
    const repoPath = resolveRepoPath(req.params.projectId);
    // Returns { specs, invalid }: usable specs plus any present-but-invalid spec
    // files (with their validation errors) so the UI can distinguish a schema
    // mismatch from a genuinely empty project.
    res.json(discoverSpecs(repoPath));
  } catch (err) {
    handleError(res, err);
  }
});

// 2. Validate a manual path (FR-003), constrained to the registered project repo.
router.post("/:projectId/testbench/specs/validate", (req, res) => {
  try {
    const repoPath = resolveRepoPath(req.params.projectId);
    const parsed = ValidatePathBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, errors: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const result = validateManualPath(repoPath, parsed.data.path);
    if (result.ok) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    handleError(res, err);
  }
});

// 3. Archive / supersede a spec, or reverse either (#1166, SATCA-FR-020/FR-021).
//
// Resolved against the PROJECT repoPath, not a bench worktree: the picker is
// project-scoped, and GET /testbench/specs (the list this write mutates) reads
// from the same root. The bench-scoped routes below deliberately use the bench's
// own workspacePath instead; the two roots are not interchangeable.
//
// Body: `{ lifecycle: <record> | null }`. A record archives (optionally
// recording a reason and the spec that superseded this one); `null` clears the
// record, which is how every lifecycle action is reversed from the surface that
// applied it (SATCA-FR-021). Absence, not `archived: false`, is the live state.
//
// `supersededBy` is checked against the project's OTHER discovered specs before
// anything is written, so an in-app supersession can never leave a dangling
// pointer (SATCA-FR-028). The shape check in the schema is not enough on its
// own: a well-formed slug naming no spec would validate.
//
// Responds with the freshly computed SpecLifecycleState, read back through the
// same fail-open ladder discovery uses, so the client never has to guess what
// landed on disk. The write leaves the change uncommitted in the worktree by
// design.
router.put("/:projectId/testbench/specs/:slug/lifecycle", (req, res) => {
  try {
    const repoPath = resolveRepoPath(req.params.projectId);
    const parsed = SpecLifecycleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "lifecycle must be a valid spec lifecycle record, or null to clear it",
        errors: parsed.error.issues.map((i) => {
          const field = i.path.join(".");
          return field ? `${field}: ${i.message}` : i.message;
        }),
      });
      return;
    }

    const slug = req.params.slug;
    const record = parsed.data.lifecycle;
    if (record !== null && record.supersededBy !== undefined) {
      if (record.supersededBy === slug) {
        res.status(400).json({ error: "A spec cannot supersede itself" });
        return;
      }
      const known = discoverSpecs(repoPath).specs.some((s) => s.slug === record.supersededBy);
      if (!known) {
        res.status(400).json({
          error: `No spec '${record.supersededBy}' in this project; a superseding spec must be one of the project's other specifications`,
        });
        return;
      }
    }

    writeSpecLifecycle(repoPath, slug, record);
    res.json(computeLifecycle(repoPath, slug));
  } catch (err) {
    handleError(res, err);
  }
});

// Parse a comma-separated ?gateIds= query value into a de-duplicated, non-empty
// list of gate ids, preserving first-seen order. Returns undefined when the
// param is absent (the full-plan path); returns [] when present but empty (an
// explicit empty filter, which narrows the plan to no cases). A repeated query
// param (?gateIds=a&gateIds=b) arrives as an array; both forms are flattened.
function parseGateIdsParam(raw: unknown): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const values = Array.isArray(raw) ? raw : [raw];
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed.length > 0 && !ids.includes(trimmed)) {
        ids.push(trimmed);
      }
    }
  }
  return ids;
}

// 4. Load plan + results (fail-open: never 500 for a corrupt/missing results
// sidecar, which testbench-store surfaces as a recovery payload).
//
// Optional ?gateIds= subset filter (FR-008, AC2): when present, the plan's cases
// are narrowed to the union of the named gates' implements.test_case_ids (the raw
// declared gating set, not the L3/L4-narrowed set: the gate evaluator owns that
// narrowing), and a `filteredToGateIds` marker is added to the response so an
// existing no-param caller gets the unchanged full-plan shape. The named ids are
// resolved against the EFFECTIVE (operator override-applied) gates, so a synthetic
// merged gate id (MERGED:...) resolves to the union of its source gates' cases
// (#913), not zero. An unknown gate id in the filter contributes nothing (no
// error): the union of known gates wins.
//
// The response also carries the focused spec's read-only `lifecycle` state (#1162,
// SATCA-FR-018), so an open panel can say that the spec it is showing has been
// archived. It is read from `rootPath`, the BENCH's own workspace, not from the
// project repo discovery walks: archived-ness is a property of what this bench's
// workspace says, so two benches on different branches can legitimately disagree
// until the change is merged. computeLifecycle is fail-open, so a missing or
// unreadable manifest reads live and never fails the plan read.
router.get(
  "/:projectId/benches/:id/testbench/plan",
  planReadRateLimiter,
  (req: Request<{ projectId: string; id: string }>, res: Response) => {
    try {
      const benchId = parseIntParam(req.params.id, "bench id");
      const { rootPath, slug } = resolveTestbench(req.params.projectId, benchId, "read");
      const result = testbenchStore.readPlanAndResults(rootPath, slug);
      const lifecycle = computeLifecycle(rootPath, slug);

      const gateIds = parseGateIdsParam(req.query.gateIds);
      if (gateIds === undefined) {
        // No filter: the full-plan response, plus the lifecycle marker.
        res.json({ ...result, lifecycle });
        return;
      }

      // Resolve the named gates from this spec's EFFECTIVE (override-applied)
      // gating set and union their declared gating sets. A synthetic
      // operator-merged gate id (MERGED:...) matches no raw work-unit id, so the
      // raw units must first have the project's recorded merge / split overrides
      // applied (mirroring gates.ts effectiveGates), or a merged batch resolves to
      // zero cases (#913). Gates live alongside the plan under the bench's own
      // worktree, so load the units and case map from the same rootPath + slug the
      // plan was read from; the overrides document is keyed by projectId.
      const loaded = workUnitLoader.loadVerifyUnits(rootPath, slug);
      const overrides = gateOverrideStore.loadOverrides(req.params.projectId);
      const caseMap = workUnitLoader.buildWorkUnitCaseMap(rootPath, slug);
      const effective = applyGateOverrides(loaded, overrides, caseMap).gates;
      const selected = effective.filter((g) => gateIds.includes(g.unit.id));
      const subsetCaseIds = new Set<string>();
      for (const g of selected) {
        for (const caseId of g.unit.implements.test_case_ids) {
          subsetCaseIds.add(caseId);
        }
      }

      const filteredPlan = {
        ...result.plan,
        cases: result.plan.cases.filter((c) => subsetCaseIds.has(c.id)),
      };
      res.json({ ...result, plan: filteredPlan, filteredToGateIds: gateIds, lifecycle });
    } catch (err) {
      handleError(res, err);
    }
  },
);

// One candidate case as the picker needs it: enough to render a row (id, title,
// area, level) plus the lifecycle block the resolver walks. Deliberately NOT the
// whole Case: steps and observations are megabytes of payload the picker never
// reads, and a candidate list is not a plan.
interface CandidateCase {
  id: string;
  title: string;
  area: string;
  level: number;
  lifecycle?: Case["lifecycle"];
}

function toCandidateCase(testCase: Case): CandidateCase {
  return {
    id: testCase.id,
    title: testCase.title,
    area: testCase.area,
    level: testCase.level,
    ...(testCase.lifecycle ? { lifecycle: testCase.lifecycle } : {}),
  };
}

// 4b. Replacement candidates for the two-stage picker (#1169, SATCA-FR-028/FR-029).
//
// Read-only. Returns everything the client needs to render the picker AND to
// resolve a candidate pointer with the shared LifecycleResolver itself: the
// authoring-time preview must call the same resolver the gate calls, so the
// server hands over plans rather than resolving on the client's behalf
// (architecture.md, "ReplacementPicker to LifecycleResolver").
//
// The response carries the TRANSITIVE CLOSURE of the requested spec's pointer
// graph, discovered with the resolver's own `collectReferencedSlugs` rule and
// bounded by MAX_SUPERSESSION_DEPTH, plus the bench's origin spec. Returning the
// closure (rather than one spec per request) is what keeps `target spec not
// supplied` a genuine finding about the repository instead of an artefact of
// what the client happened to fetch.
//
// Rooted at the BENCH's own workspace, exactly like the plan route: archived-ness
// and case content are properties of this bench's branch, so two benches on
// different branches can legitimately disagree until the change is merged.
//
// `?slug=` selects which specification's cases to list; it defaults to the
// bench's focused spec. The slug must name a spec discovery found in this
// workspace, which is what keeps an attacker-supplied slug off the filesystem
// (discovery only ever yields allowlisted slugs).
//
// Fails open per spec the way discovery does: a spec whose plan cannot be read is
// simply absent from `plans`, which the resolver reports honestly as `target spec
// not supplied` rather than as a resolvable pointer.
router.get(
  "/:projectId/benches/:id/testbench/replacement-candidates",
  planReadRateLimiter,
  (req: Request<{ projectId: string; id: string }>, res: Response) => {
    try {
      const benchId = parseIntParam(req.params.id, "bench id");
      const { rootPath, slug: originSlug } = resolveTestbench(
        req.params.projectId,
        benchId,
        "read",
      );

      const discovered = discoverSpecs(rootPath).specs;
      const rawSlug = req.query.slug;
      const requestedSlug =
        typeof rawSlug === "string" && rawSlug.length > 0 ? rawSlug : originSlug;
      if (requestedSlug !== originSlug && !discovered.some((s) => s.slug === requestedSlug)) {
        throw new RouteError(404, `No spec '${requestedSlug}' in this bench's workspace`);
      }

      // Walk the closure. Each loaded plan names the next slugs to load, which is
      // the resolver's own sanctioned "what to load next" rule; the depth bound
      // matches the walk the preview will run over the result.
      const plans: Record<string, ResolverPlan & { cases: CandidateCase[] }> = {};
      const queue = [requestedSlug, originSlug];
      const seen = new Set<string>();
      let hops = 0;
      while (queue.length > 0 && hops <= MAX_SUPERSESSION_DEPTH) {
        const batch = queue.splice(0, queue.length);
        for (const candidate of batch) {
          if (seen.has(candidate)) continue;
          seen.add(candidate);
          // Only ever read a slug discovery vouched for, plus the bench's own
          // focused slug (which resolveTestbench already validated).
          if (candidate !== originSlug && !discovered.some((s) => s.slug === candidate)) continue;
          let cases: CandidateCase[];
          try {
            cases = testbenchStore
              .readPlanAndResults(rootPath, candidate)
              .plan.cases.map(toCandidateCase);
          } catch {
            // Fail open for this one spec: absent from `plans`, so the resolver
            // says "target spec not supplied" instead of silently resolving.
            continue;
          }
          const loaded = { specSlug: candidate, cases };
          plans[candidate] = loaded;
          queue.push(...collectReferencedSlugs(loaded));
        }
        hops += 1;
      }

      // Only ARCHIVED specs carry a record: absence is the live state
      // (SATCA-FR-017), which is exactly the shape the resolver's
      // `specLifecycles` map expects.
      const specLifecycles: Record<
        string,
        { archived: true; reason?: string; supersededBy?: string }
      > = {};
      for (const loadedSlug of Object.keys(plans)) {
        const lifecycle = computeLifecycle(rootPath, loadedSlug);
        if (!lifecycle.archived) continue;
        specLifecycles[loadedSlug] = {
          archived: true,
          ...(lifecycle.reason !== null ? { reason: lifecycle.reason } : {}),
          ...(lifecycle.supersededBy !== null ? { supersededBy: lifecycle.supersededBy } : {}),
        };
      }

      res.json({
        originSlug,
        slug: requestedSlug,
        specs: discovered.map((s) => ({
          slug: s.slug,
          caseCount: s.caseCount,
          archived: s.lifecycle.archived,
        })),
        plans,
        specLifecycles,
      });
    } catch (err) {
      handleError(res, err);
    }
  },
);

// 5. Mark an observation (PUT) -> 200 CaseResult.
router.put(
  "/:projectId/benches/:id/testbench/cases/:caseId/observations/:observationId",
  async (req, res) => {
    try {
      const benchId = parseIntParam(req.params.id, "bench id");
      const { rootPath, slug } = await resolveTestbenchForMark(req.params.projectId, benchId);
      const parsed = MarkObservationBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "result must be 'pass', 'fail', or null" });
        return;
      }
      const caseResult = await testbenchStore.markObservation(
        rootPath,
        slug,
        req.params.caseId,
        req.params.observationId,
        parsed.data.result,
      );
      res.json(caseResult);
    } catch (err) {
      handleError(res, err);
    }
  },
);

// 6. Set/clear a status override (PUT) -> 200 CaseResult (null clears).
//
// Body: { override, evidence?: { note?, screenshot? } } (SB-FR-027). The
// screenshot is a base64 PNG, JPEG or WebP data URL; it is written under
// `.specifications/<slug>/evidence/<caseId>/`, and the note, with the
// screenshot's path relative to the spec folder, is appended to the case's
// notes after the override is written. Malformed evidence is a 400 before any
// write. The bench variant's provider can add keys to the answer beside the
// CaseResult: a Spec Bench answers a Not met mark with the fix unit it filed
// (`fixUnit`), or why it filed none (`fixUnitError`).
router.put("/:projectId/benches/:id/testbench/cases/:caseId/status", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { bench, rootPath, slug } = await resolveTestbenchForMark(req.params.projectId, benchId);
    const parsed = SetStatusBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "override must be a valid CaseStatus or null" });
      return;
    }
    const { override, evidence } = parsed.data;
    const caseId = req.params.caseId;
    let screenshot: CaseScreenshot | undefined;
    if (evidence?.screenshot !== undefined) {
      screenshot = decodeCaseScreenshot(evidence.screenshot);
    }
    let caseResult = await testbenchStore.setStatusOverride(rootPath, slug, caseId, override);
    const screenshotPath =
      screenshot === undefined
        ? undefined
        : writeCaseScreenshot(rootPath, slug, caseId, screenshot);
    const noteText = caseEvidenceNoteText(evidence?.note, screenshotPath);
    if (noteText.length > 0) {
      const note = await testbenchStore.appendNote(rootPath, slug, caseId, noteText);
      caseResult = { ...caseResult, notes: [...caseResult.notes, note] };
    }
    const provider = getTestbenchHostProvider(bench.variant);
    const extra =
      provider?.afterStatusMark === undefined
        ? {}
        : await provider.afterStatusMark(bench, {
            rootPath,
            slug,
            caseId,
            override,
            ...(evidence?.note !== undefined && { note: evidence.note }),
          });
    res.json({
      ...caseResult,
      ...extra,
      ...(screenshotPath !== undefined && { evidence: { screenshot: screenshotPath } }),
    });
  } catch (err) {
    handleError(res, err);
  }
});

// 6b. Set or clear a case's lifecycle record (PUT) -> 200 with the updated case
// (#1167, SATCA-FR-019/FR-021). The body is
// { lifecycle: { state: "retired", reason } } or
// { lifecycle: { state: "superseded", replacement, reason? } }, or
// { lifecycle: null } to restore, which removes the record and is what makes
// every action reversible.
//
// `If-Match` carries the caller's view of the case file: the
// `caseFileFingerprint` the plan read returned, a sha256 over the RAW file bytes.
// It is REQUIRED, not optional. The plan hash cannot stand in for it, because
// canonicalization excludes the lifecycle block (#1160) and so is byte-identical
// across a lifecycle edit; without the fingerprint a write from a stale view
// would silently overwrite an edit made outside the app (SATCA-TC-056). A
// mismatch is a 409 via handleError.
router.put("/:projectId/benches/:id/testbench/cases/:caseId/lifecycle", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = await resolveTestbenchForMark(req.params.projectId, benchId);
    const ifMatch = req.get("if-match");
    if (typeof ifMatch !== "string" || ifMatch.length === 0) {
      res.status(400).json({
        error: "An If-Match case-file fingerprint is required for a lifecycle write",
      });
      return;
    }
    const parsed = SetCaseLifecycleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "lifecycle must be a valid lifecycle record or null",
        errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
      return;
    }
    const result = testbenchStore.setCaseLifecycle(
      rootPath,
      slug,
      req.params.caseId,
      parsed.data.lifecycle,
      ifMatch,
    );
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// 7. Append a note (POST) -> 201 Note (400 on empty text).
router.post("/:projectId/benches/:id/testbench/cases/:caseId/notes", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = await resolveTestbenchForMark(req.params.projectId, benchId);
    const parsed = AppendNoteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "text must be a string" });
      return;
    }
    if (parsed.data.text.trim().length === 0) {
      res.status(400).json({ error: "Note text must not be empty" });
      return;
    }
    const note = await testbenchStore.appendNote(
      rootPath,
      slug,
      req.params.caseId,
      parsed.data.text,
    );
    res.status(201).json(note);
  } catch (err) {
    handleError(res, err);
  }
});

// 7b. Stage a case from its state recipe (POST) -> 200 with the step report
// (SB-FR-025, SB-US-009). The recipe is
// `<pin checkout>/.specifications/<slug>/state-recipes/<caseId>.json`, beside
// the delivery record, in the gate pin of the bench's sitting. It is validated
// against the state recipe contract, guarded against the pin commit, and
// replayed there step by step. 404 RECIPE_NOT_FOUND when the case has none (it
// opens cold), 409 RECIPE_COMMIT_MISMATCH naming the pin commit when the recipe
// was recorded at another commit, 409 NO_GATE_PIN when the bench has no pin,
// 400 RECIPE_INVALID when the recipe does not validate, and 422 with the same
// report when a step fails. Staging is part of the sitting, so the bench
// resolves as for a mark.
router.post("/:projectId/benches/:id/testbench/cases/:caseId/stage", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { bench, slug } = await resolveTestbenchForMark(req.params.projectId, benchId);
    const { ok, report } = await stageCaseFromRecipe(bench, slug, req.params.caseId);
    if (ok) {
      res.json(report);
      return;
    }
    const failed = report.steps.find((step) => step.status === "failed");
    res.status(422).json({
      ...report,
      error: `Step ${failed?.index ?? "?"} (${failed?.kind ?? "unknown"}) of the state recipe failed${
        failed?.detail === undefined ? "" : `: ${failed.detail}`
      }`,
      code: "RECIPE_STEP_FAILED",
    });
  } catch (err) {
    handleError(res, err);
  }
});

// 8. Reconcile (POST) -> 200 { classification, applied }. Without confirm,
// returns the preview only; orphan purge requires an explicit flag (NFR-003).
router.post("/:projectId/benches/:id/testbench/reconcile", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = await resolveTestbenchForMark(req.params.projectId, benchId);
    const parsed = ReconcileBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "confirm and purgeOrphans must be booleans" });
      return;
    }
    const outcome = await testbenchStore.reconcile(rootPath, slug, {
      confirm: parsed.data.confirm,
      purgeOrphans: parsed.data.purgeOrphans,
    });
    res.json(outcome);
  } catch (err) {
    handleError(res, err);
  }
});

// 9. Re-point the focused spec (PUT) -> 200 Bench. The prior spec's results stay
// untouched; staleness is re-evaluated on the next plan load.
router.put("/:projectId/benches/:id/testbench/focus", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const parsed = FocusBodySchema.safeParse(req.body);
    if (!parsed.success || parsed.data.focusedSpecPath.length === 0) {
      res.status(400).json({ error: "focusedSpecPath must be a non-empty string" });
      return;
    }
    const bench = benchManager.setFocusedSpecPath(
      req.params.projectId,
      benchId,
      parsed.data.focusedSpecPath,
    );
    res.json(bench);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
