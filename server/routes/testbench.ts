// REST surface for the TestBench (#416). Shaped like inspection.ts: thin handlers
// that resolve the project repoPath + bench, validate request bodies with the
// testbench-contracts zod schemas, derive the spec slug from the bench's
// focusedSpecPath, then delegate every filesystem write to testbench-store (which
// resolves git identity and enforces NFR-001/NFR-003 internally). The route layer
// never touches the filesystem directly.
//
// Endpoints (all under /api/projects):
//   GET    /:projectId/testbench/specs
//   POST   /:projectId/testbench/specs/validate
//   GET    /:projectId/benches/:id/testbench/plan
//   PUT    /:projectId/benches/:id/testbench/cases/:caseId/observations/:observationId
//   PUT    /:projectId/benches/:id/testbench/cases/:caseId/status
//   POST   /:projectId/benches/:id/testbench/cases/:caseId/notes
//   POST   /:projectId/benches/:id/testbench/reconcile
//   PUT    /:projectId/benches/:id/testbench/focus
//
// The TestBench create endpoint (POST /:projectId/benches { variant }) lives in
// benches.ts: it is the normal bench-manager create path.

import { Router } from "express";
import { z } from "zod";
import * as benchManager from "../services/bench-manager.js";
import { BenchError } from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import * as testbenchStore from "../lib/testbench-store.js";
import { MissingPlanError, UnsafePathError } from "../lib/testbench-store.js";
import {
  discoverSpecs,
  resolveFocusedSpec,
  validateManualPath,
} from "../lib/testbench-spec-discovery.js";
import { RouteError, parseIntParam } from "./helpers.js";
import { CaseStatusSchema } from "@roubo/shared/testbench-contracts";

const router = Router();

// Request-body schemas (testbench-contracts-aligned). Each is strict so an
// unexpected key is a 400 rather than silently ignored.
const ValidatePathBodySchema = z.object({ path: z.string() }).strict();
// result is pass | fail to set a mark, or null to clear (un-set) it (#508).
const MarkObservationBodySchema = z
  .object({ result: z.enum(["pass", "fail"]).nullable() })
  .strict();
const SetStatusBodySchema = z.object({ override: CaseStatusSchema.nullable() }).strict();
const AppendNoteBodySchema = z.object({ text: z.string() }).strict();
const ReconcileBodySchema = z
  .object({ confirm: z.boolean().optional(), purgeOrphans: z.boolean().optional() })
  .strict();
const FocusBodySchema = z.object({ focusedSpecPath: z.string() }).strict();

// Resolve a registered project's repoPath, or throw a 404 RouteError. Centralised
// so every handler resolves it the same way.
function resolveRepoPath(projectId: string): string {
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.config) {
    throw new RouteError(404, `Project '${projectId}' not found`);
  }
  return project.repoPath;
}

// Resolve a TestBench and derive the (rootPath, slug) tuple the store needs.
// `rootPath` is the bench's own worktree (#493): the plan and the results sidecar
// are both read and written under `bench.workspacePath/.specifications/<slug>/`,
// not the registered project repoPath. The slug is still resolved against the
// project repoPath, where the focused spec path was picked and validated.
//
// Throws RouteError(404) when the bench is missing, RouteError(400) when it is
// not a testbench / has no focused spec, the focused path is malformed, or the
// bench has no usable workspace path (an error-state bench must not write to a
// bogus root).
function resolveTestbench(projectId: string, benchId: number): { rootPath: string; slug: string } {
  const repoPath = resolveRepoPath(projectId);
  const bench = benchManager.getBench(projectId, benchId);
  if (!bench) {
    throw new RouteError(404, "Bench not found");
  }
  if (bench.variant !== "testbench" || bench.focusedSpecPath === undefined) {
    throw new RouteError(400, "Bench is not a testbench or has no focused spec");
  }
  const rootPath = bench.workspacePath;
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    throw new RouteError(400, "Bench has no workspace path");
  }
  let slug: string;
  try {
    slug = resolveFocusedSpec(repoPath, bench.focusedSpecPath).slug;
  } catch (err) {
    throw new RouteError(400, `Invalid focusedSpecPath: ${(err as Error).message}`);
  }
  return { rootPath, slug };
}

// Map any thrown error to an HTTP response, mirroring inspection.ts: RouteError /
// BenchError carry a statusCode, MissingPlanError -> 404, UnsafePathError -> 400,
// everything else -> 500.
function handleError(res: import("express").Response, err: unknown): void {
  if (err instanceof RouteError) {
    res.status(err.statusCode).json({ error: err.message });
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
  if (err instanceof UnsafePathError) {
    res.status(400).json({ error: err.message });
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

// 4. Load plan + results (fail-open: never 500 for a corrupt/missing results
// sidecar, which testbench-store surfaces as a recovery payload).
router.get("/:projectId/benches/:id/testbench/plan", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = resolveTestbench(req.params.projectId, benchId);
    const result = testbenchStore.readPlanAndResults(rootPath, slug);
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

// 5. Mark an observation (PUT) -> 200 CaseResult.
router.put(
  "/:projectId/benches/:id/testbench/cases/:caseId/observations/:observationId",
  async (req, res) => {
    try {
      const benchId = parseIntParam(req.params.id, "bench id");
      const { rootPath, slug } = resolveTestbench(req.params.projectId, benchId);
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
router.put("/:projectId/benches/:id/testbench/cases/:caseId/status", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = resolveTestbench(req.params.projectId, benchId);
    const parsed = SetStatusBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "override must be a valid CaseStatus or null" });
      return;
    }
    const caseResult = await testbenchStore.setStatusOverride(
      rootPath,
      slug,
      req.params.caseId,
      parsed.data.override,
    );
    res.json(caseResult);
  } catch (err) {
    handleError(res, err);
  }
});

// 7. Append a note (POST) -> 201 Note (400 on empty text).
router.post("/:projectId/benches/:id/testbench/cases/:caseId/notes", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = resolveTestbench(req.params.projectId, benchId);
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

// 8. Reconcile (POST) -> 200 { classification, applied }. Without confirm,
// returns the preview only; orphan purge requires an explicit flag (NFR-003).
router.post("/:projectId/benches/:id/testbench/reconcile", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { rootPath, slug } = resolveTestbench(req.params.projectId, benchId);
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
