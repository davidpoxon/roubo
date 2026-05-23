import { Router } from "express";
import * as projectRegistry from "../services/project-registry.js";
import * as benchManager from "../services/bench-manager.js";
import * as jigManager from "../services/jig-manager.js";
import {
  buildPreviewContext,
  getSampleResolveContext,
  findUnresolvedVariables,
} from "../services/jig-preview.js";
import type {
  JigCreateRequest,
  JigUpdateRequest,
  JigPreviewRequest,
  JigPreviewResponse,
} from "@roubo/shared";
import { VALID_JIG_ID, handleJigError } from "./helpers.js";

const HARD_SIZE_LIMIT = 200 * 1024;

const router = Router();

router.get("/", (_req, res) => {
  res.json(jigManager.listGlobalJigs());
});

router.post("/", (req, res) => {
  try {
    const body = req.body as JigCreateRequest;
    const created = jigManager.createAppJig(body);
    res.status(201).json(created);
  } catch (err) {
    handleJigError(res, err);
  }
});

// Must be declared before /:id to avoid matching 'preview' as a jig id on POST.
router.post("/preview", async (req, res) => {
  const { content } = req.body as JigPreviewRequest;
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

  const resolved = jigManager.resolveJigContent(content, ctx);
  const response: JigPreviewResponse = {
    resolved,
    unresolvedVariables: findUnresolvedVariables(resolved),
  };
  res.json(response);
});

router.get("/:id", (req, res) => {
  const { id } = req.params;
  if (!VALID_JIG_ID.test(id)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }
  const jig = jigManager.getAppJig(id);
  if (!jig) {
    res.status(404).json({ error: "Jig not found" });
    return;
  }
  res.json(jig);
});

router.put("/:id", (req, res) => {
  const { id } = req.params;
  if (!VALID_JIG_ID.test(id)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }
  try {
    const body = req.body as JigUpdateRequest;
    const updated = jigManager.updateAppJig(id, body);
    res.json(updated);
  } catch (err) {
    handleJigError(res, err);
  }
});

router.delete("/:id", (req, res) => {
  const { id } = req.params;
  if (!VALID_JIG_ID.test(id)) {
    res.status(400).json({ error: "Invalid jig id" });
    return;
  }
  try {
    jigManager.deleteAppJig(id);
    res.status(204).send();
  } catch (err) {
    handleJigError(res, err);
  }
});

export default router;
