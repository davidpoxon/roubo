// The spec reads of the Set up Spec Bench dialog (SB-FR-001).
//
// Endpoints (mounted under /api/projects):
//   GET /:projectId/specbench/specs/:slug/summary
//                         -> 200 SpecBenchSpecSummary {slug, units, gates}: the
//                            spec's work units that deliver code (every kind but
//                            verify) and its verify gates, counted from
//                            `.specifications/<slug>/work-units.json` in the
//                            project checkout; 0 and 0 when the file is absent
//                            400 INVALID_SLUG: the slug fails the spec-slug allowlist
//                            400 WORK_UNITS_INVALID + errors: the file is present but
//                                does not validate
//                            404 NOT_FOUND: no such registered project
//
// The dialog lists the specs from GET /:projectId/testbench/specs and creates
// the bench with POST /:projectId/benches { variant: "specbench" } (benches.ts).
import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { SpecBenchSpecSummary } from "@roubo/shared/delivery-bench";
import * as projectRegistry from "../services/project-registry.js";
import * as workUnitLoader from "../services/work-unit-loader.js";
import { UnsafePathError } from "../lib/safe-path.js";

const router = Router();

// The handler reads the spec's work-units.json from disk (CodeQL
// js/missing-rate-limiting).
const summaryReadRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

router.get("/:projectId/specbench/specs/:slug/summary", summaryReadRateLimiter, (req, res) => {
  const projectId = String(req.params.projectId);
  const project = projectRegistry.getProject(projectId);
  if (!project || !project.config) {
    res.status(404).json({ error: `Project '${projectId}' not found`, code: "NOT_FOUND" });
    return;
  }
  const slug = String(req.params.slug);
  try {
    const units = workUnitLoader.loadAllUnitsForSlug(project.repoPath, slug);
    const gates = units.filter((unit) => unit.kind === "verify").length;
    const body: SpecBenchSpecSummary = { slug, units: units.length - gates, gates };
    res.json(body);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      res.status(400).json({ error: err.message, code: "INVALID_SLUG" });
      return;
    }
    if (err instanceof workUnitLoader.WorkUnitsValidationError) {
      res.status(400).json({ error: err.message, code: "WORK_UNITS_INVALID", errors: err.errors });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
