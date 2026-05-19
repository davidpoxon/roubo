import { Router } from "express";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as blueprintManager from "../services/blueprint-manager.js";
import {
  buildPreviewContext,
  getSampleResolveContext,
  findUnresolvedVariables,
} from "../services/blueprint-preview.js";
import type {
  BlueprintCreateRequest,
  BlueprintUpdateRequest,
  BlueprintPreviewRequest,
  BlueprintPreviewResponse,
} from "@roubo/shared";
import { VALID_BLUEPRINT_ID, handleBlueprintError } from "./helpers.js";

const HARD_SIZE_LIMIT = 200 * 1024;

const router = Router();

router.get("/", (_req, res) => {
  res.json(blueprintManager.listGlobalBlueprints());
});

router.post("/", (req, res) => {
  try {
    const body = req.body as BlueprintCreateRequest;
    const created = blueprintManager.createAppBlueprint(body);
    res.status(201).json(created);
  } catch (err) {
    handleBlueprintError(res, err);
  }
});

// Must be declared before /:id to avoid matching 'preview' as a blueprint id on POST.
router.post("/preview", async (req, res) => {
  const { content } = req.body as BlueprintPreviewRequest;
  const rawProjectId = req.body.projectId;
  const projectId = typeof rawProjectId === "string" ? rawProjectId : undefined;
  const rawBenchId = req.body.benchId;
  const benchId = typeof rawBenchId === "number" ? rawBenchId : undefined;

  if (!content || typeof content !== "string") {
    res.status(400).json({ error: "content is required" });
    return;
  }
  if (Buffer.byteLength(content, "utf8") > HARD_SIZE_LIMIT) {
    res.status(400).json({ error: "Content exceeds the 200 KB limit" });
    return;
  }

  let ctx: Awaited<ReturnType<typeof buildPreviewContext>>;

  if (projectId && benchId != null) {
    const project = projectRegistry.getProject(projectId);
    const bench = project ? benchManager.getBench(projectId, benchId) : undefined;
    ctx = project && bench ? await buildPreviewContext(project, bench) : getSampleResolveContext();
  } else {
    ctx = getSampleResolveContext();
  }

  const resolved = blueprintManager.resolveBlueprintContent(content, ctx);
  const response: BlueprintPreviewResponse = {
    resolved,
    unresolvedVariables: findUnresolvedVariables(resolved),
  };
  res.json(response);
});

router.get("/:id", (req, res) => {
  const { id } = req.params;
  if (!VALID_BLUEPRINT_ID.test(id)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }
  const blueprint = blueprintManager.getAppBlueprint(id);
  if (!blueprint) {
    res.status(404).json({ error: "Blueprint not found" });
    return;
  }
  res.json(blueprint);
});

router.put("/:id", (req, res) => {
  const { id } = req.params;
  if (!VALID_BLUEPRINT_ID.test(id)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }
  try {
    const body = req.body as BlueprintUpdateRequest;
    const updated = blueprintManager.updateAppBlueprint(id, body);
    res.json(updated);
  } catch (err) {
    handleBlueprintError(res, err);
  }
});

router.delete("/:id", (req, res) => {
  const { id } = req.params;
  if (!VALID_BLUEPRINT_ID.test(id)) {
    res.status(400).json({ error: "Invalid blueprint id" });
    return;
  }
  try {
    blueprintManager.deleteAppBlueprint(id);
    res.status(204).send();
  } catch (err) {
    handleBlueprintError(res, err);
  }
});

export default router;
