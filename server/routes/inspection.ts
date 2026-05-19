import { Router } from "express";
import * as inspectionRunner from "../services/inspection-runner.js";
import { ServiceError } from "../services/service-error.js";
import { RouteError, parseIntParam } from "./helpers.js";
import type { StartInspectionRequest } from "@roubo/shared";

const router = Router();

router.post("/:projectId/benches/:id/inspection", (req, res) => {
  const { projectId } = req.params;
  const { filter } = req.body as StartInspectionRequest;

  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const run = inspectionRunner.startInspection(projectId, benchId, filter);
    res.status(201).json(run);
  } catch (err) {
    const message = (err as Error).message;
    if (err instanceof RouteError || err instanceof ServiceError) {
      res.status(err.statusCode).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

router.get("/:projectId/benches/:id/inspection", (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.id, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }
  let since: number | undefined;
  if (req.query.since !== undefined) {
    try {
      since = parseIntParam(req.query.since as string, "since");
    } catch {
      res.status(400).json({ error: "Invalid since parameter" });
      return;
    }
  }

  const result = inspectionRunner.getInspectionOutput(req.params.projectId, benchId, since);
  if (!result) {
    res.status(404).json({ error: "No inspection run found" });
    return;
  }
  res.json(result.run);
});

router.delete("/:projectId/benches/:id/inspection", (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.id, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }
  const stopped = inspectionRunner.stopInspection(req.params.projectId, benchId);
  if (!stopped) {
    res.status(404).json({ error: "No active inspection run to abort" });
    return;
  }
  res.status(204).send();
});

export default router;
