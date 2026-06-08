import { Router } from "express";
import * as benchManager from "../services/bench-manager.js";
import { BenchError } from "../services/bench-manager.js";
import { buildKnownMergedLocations, getDirtyState } from "../services/git-state.js";
import * as notificationService from "../services/notification.js";
import * as toolService from "../services/tool-launcher.js";
import * as issueAssignment from "../services/issue-assignment.js";
import * as projectRegistry from "../services/project-registry.js";
import * as githubService from "../services/github.js";
import * as pluginManager from "../services/plugin-manager.js";
import { RouteError, parseIntParam } from "./helpers.js";
import { getActivePluginOrRespond } from "./plugin-route-helpers.js";
import { sendPluginRpcError } from "./plugin-rpc-error.js";
import { ServiceError } from "../services/service-error.js";
import { syncBenchWorkUnitPRs } from "../services/pr-sync.js";
import { isAlertExternalId } from "../services/alert-external-id.js";
import type {
  CreateBenchRequest,
  AssignContainerRequest,
  ExecuteToolRequest,
  NormalizedIssue,
} from "@roubo/shared";

const router = Router();

function handleCreateBenchError(res: import("express").Response, err: unknown) {
  if (err instanceof ServiceError) {
    res.status(err.statusCode).json({ ...err.data, error: err.message });
  } else if (err instanceof BenchError) {
    const status =
      err.code === "PROJECT_NOT_FOUND"
        ? 404
        : err.code === "NO_BENCHES" || err.code === "GLOBAL_CAP_REACHED"
          ? 409
          : 400;
    res.status(status).json({ error: err.message, code: err.code });
  } else {
    res.status(500).json({ error: (err as Error).message });
  }
}

function handleBenchError(res: import("express").Response, err: unknown) {
  if (err instanceof RouteError) {
    res.status(err.statusCode).json({ error: err.message });
  } else if (err instanceof BenchError) {
    const status = ["NOT_FOUND", "PROJECT_NOT_FOUND", "CONTAINER_NOT_FOUND"].includes(err.code)
      ? 404
      : 400;
    res.status(status).json({ error: err.message, code: err.code });
  } else {
    res.status(500).json({ error: (err as Error).message });
  }
}

router.get("/:projectId/benches", (req, res) => {
  let benches = benchManager.getBenches(req.params.projectId);
  const issue = parseInt(req.query.issue as string, 10);
  if (!isNaN(issue)) {
    // The ?issue= filter targets GitHub issue numbers. Alert-backed benches reuse
    // assignedIssue.number for the alert number, so skip them to avoid colliding
    // with a real issue #N. See #291.
    benches = benches.filter(
      (b) => b.assignedIssue?.number === issue && !isAlertExternalId(b.assignedIssue?.externalId),
    );
  }
  res.json(benches);
});

router.post("/:projectId/benches", async (req, res) => {
  const { branch, issueNumber, externalId, branchConflictResolution, variant, focusedSpecPath } =
    req.body as CreateBenchRequest;

  // TestBench-variant create (#416). A TestBench has no issue/branch coupling: it
  // binds a focused spec instead. Validation + containment of focusedSpecPath
  // happens inside bench-manager.createBench (BenchError "INVALID_FOCUS" -> 400).
  if (variant === "testbench") {
    if (typeof focusedSpecPath !== "string" || focusedSpecPath.length === 0) {
      res
        .status(400)
        .json({ error: "focusedSpecPath must be a non-empty string for a testbench variant" });
      return;
    }
    try {
      const bench = benchManager.createBench(req.params.projectId, undefined, {
        variant: "testbench",
        focusedSpecPath,
      });
      res.status(201).json(bench);
    } catch (err) {
      if (err instanceof BenchError) {
        const status =
          err.code === "PROJECT_NOT_FOUND"
            ? 404
            : err.code === "NO_BENCHES" || err.code === "GLOBAL_CAP_REACHED"
              ? 409
              : 400;
        res.status(status).json({ error: err.message, code: err.code });
      } else {
        res.status(500).json({ error: (err as Error).message });
      }
    }
    return;
  }

  // Combined create-and-assign flow (plain GitHub issue, by number)
  if (issueNumber !== undefined) {
    if (typeof issueNumber !== "number") {
      res.status(400).json({ error: "issueNumber must be a number" });
      return;
    }

    try {
      const result = await issueAssignment.createBenchAndAssignIssue(
        req.params.projectId,
        issueNumber,
        branchConflictResolution,
      );

      if (result.status === "conflict") {
        res.status(409).json(result);
        return;
      }

      res.status(201).json(result);
    } catch (err) {
      handleCreateBenchError(res, err);
    }
    return;
  }

  // Combined create-and-assign flow (security alert, by externalId). The alert
  // is fetched and redacted by the active plugin's getIssue, so the host only
  // ever sees the redacted NormalizedIssue (FR-043, NFR-012).
  if (externalId !== undefined) {
    if (typeof externalId !== "string" || externalId.length === 0) {
      res.status(400).json({ error: "externalId must be a non-empty string" });
      return;
    }

    const active = await getActivePluginOrRespond(req.params.projectId, res);
    if (!active) return;

    let issue: NormalizedIssue;
    try {
      issue = await pluginManager.invoke<NormalizedIssue>(active.pluginId, "getIssue", {
        externalId,
      });
    } catch (err) {
      sendPluginRpcError(res, err);
      return;
    }

    try {
      const result = await issueAssignment.createBenchAndAssignAlert(
        req.params.projectId,
        issue,
        branchConflictResolution,
      );
      if (result.status === "conflict") {
        res.status(409).json(result);
        return;
      }
      res.status(201).json(result);
    } catch (err) {
      handleCreateBenchError(res, err);
    }
    return;
  }

  // Existing flow: create bench without issue
  if (branch !== undefined) {
    if (typeof branch !== "string" || !branch || !/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branch)) {
      res.status(400).json({
        error:
          "Invalid branch name. Only alphanumeric characters, slashes, underscores, dots, and hyphens are allowed.",
      });
      return;
    }
  }

  try {
    const bench = benchManager.createBench(req.params.projectId, branch);
    res.status(201).json(bench);
  } catch (err) {
    if (err instanceof BenchError) {
      const status =
        err.code === "PROJECT_NOT_FOUND"
          ? 404
          : err.code === "NO_BENCHES" || err.code === "GLOBAL_CAP_REACHED"
            ? 409
            : 400;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.get("/:projectId/benches/:id", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = benchManager.getBench(req.params.projectId, benchId);
    if (!bench) {
      res.status(404).json({ error: "Bench not found" });
      return;
    }

    let enrichedBench = bench;
    if (
      bench.assignedIssue &&
      !isAlertExternalId(bench.assignedIssue.externalId) &&
      projectRegistry.resolveEnforceIssueDependencies(req.params.projectId)
    ) {
      const repo = projectRegistry.getProject(req.params.projectId)?.config?.project?.repo;
      if (repo) {
        try {
          const { blockedBy: blockedByMap } = await githubService.fetchBlockingRelationships(repo, [
            bench.assignedIssue.number,
          ]);
          const blockedBy = blockedByMap[bench.assignedIssue.number];
          if (blockedBy && blockedBy.length > 0) {
            enrichedBench = {
              ...bench,
              assignedIssue: { ...bench.assignedIssue, blockedBy },
            };
          }
        } catch {
          // Blocking data is informational; fail silently
        }
      }
    }

    res.json(enrichedBench);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.delete("/:projectId/benches/:id", async (req, res) => {
  const removeWorkspace = req.query.removeWorkspace === "true";
  const force = req.query.force === "true";

  try {
    const benchId = parseIntParam(req.params.id, "bench id");

    if (removeWorkspace) {
      const bench = benchManager.getBench(req.params.projectId, benchId);
      if (!bench) {
        res.status(404).json({ error: "Bench not found" });
        return;
      }

      // getDirtyState treats a blank-workspacePath bench (allowlist-rejected, see
      // bench-manager.initialize()) as clean, so this never probes git with cwd="".
      const dirtyState = await getDirtyState(bench, {
        knownMergedLocations: buildKnownMergedLocations(bench),
      });
      if (!dirtyState.clean && !force) {
        res.status(409).json({
          error: "Bench has uncommitted work; pass force=true to override",
          code: "bench-dirty",
          reasons: dirtyState.reasons,
        });
        return;
      }
    }

    const bench = benchManager.teardownBench(req.params.projectId, benchId, removeWorkspace);
    res.status(202).json(bench);
  } catch (err) {
    if (err instanceof RouteError) {
      res.status(err.statusCode).json({ error: err.message });
    } else if (err instanceof BenchError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.post("/:projectId/benches/:id/work-units/:submodule/ignore-for-auto-clear", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const { ignored } = req.body as { ignored: unknown };
    if (typeof ignored !== "boolean") {
      res.status(400).json({ error: "ignored must be a boolean" });
      return;
    }
    const bench = benchManager.setWorkUnitIgnoredForAutoClear(
      req.params.projectId,
      benchId,
      req.params.submodule,
      ignored,
    );
    res.json(bench);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.post("/:projectId/benches/:id/cleanup-and-retry", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = await benchManager.cleanupAndRetryBench(req.params.projectId, benchId);
    res.json(bench);
  } catch (err) {
    if (err instanceof RouteError) {
      res.status(err.statusCode).json({ error: err.message });
    } else if (err instanceof BenchError) {
      const status =
        err.code === "NOT_FOUND" || err.code === "PROJECT_NOT_FOUND"
          ? 404
          : err.code === "INVALID_STATE"
            ? 409
            : 400;
      res.status(status).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.post("/:projectId/benches/:id/start", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = benchManager.startAllComponents(req.params.projectId, benchId);
    res.json(bench);
  } catch (err) {
    if (err instanceof RouteError) {
      res.status(err.statusCode).json({ error: err.message });
    } else if (err instanceof BenchError) {
      res.status(400).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.post("/:projectId/benches/:id/stop", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    await benchManager.stopAllComponents(req.params.projectId, benchId);
    const bench = benchManager.getBench(req.params.projectId, benchId);
    res.json(bench);
  } catch (err) {
    if (err instanceof RouteError) {
      res.status(err.statusCode).json({ error: err.message });
    } else if (err instanceof BenchError) {
      res.status(400).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.post("/:projectId/benches/:id/sync", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = benchManager.getBench(req.params.projectId, benchId);
    if (!bench) {
      res.status(404).json({ error: "Bench not found" });
      return;
    }
    if (!bench.workUnits || bench.workUnits.length === 0) {
      res.status(400).json({ error: "Bench has no work units to sync" });
      return;
    }
    await syncBenchWorkUnitPRs(req.params.projectId, bench);
    const updated = benchManager.getBench(req.params.projectId, benchId);
    if (!updated) {
      res.status(404).json({ error: "Bench not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.post("/:projectId/benches/:id/components/:name/start", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    await benchManager.startComponent(req.params.projectId, benchId, req.params.name);
    const bench = benchManager.getBench(req.params.projectId, benchId);
    res.json(bench);
  } catch (err) {
    if (err instanceof RouteError) {
      res.status(err.statusCode).json({ error: err.message });
    } else if (err instanceof BenchError) {
      res.status(400).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.post("/:projectId/benches/:id/components/:name/stop", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    await benchManager.stopComponent(req.params.projectId, benchId, req.params.name);
    const bench = benchManager.getBench(req.params.projectId, benchId);
    res.json(bench);
  } catch (err) {
    if (err instanceof RouteError) {
      res.status(err.statusCode).json({ error: err.message });
    } else if (err instanceof BenchError) {
      res.status(400).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: (err as Error).message });
    }
  }
});

router.get("/:projectId/benches/:id/components/:name/logs", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const parsedTail = parseInt(req.query.tail as string, 10);
    const tail = Number.isNaN(parsedTail) ? 200 : parsedTail;
    const logs = benchManager.getComponentLogs(
      req.params.projectId,
      benchId,
      req.params.name,
      tail,
    );
    res.json({ logs });
  } catch (err) {
    handleBenchError(res, err);
  }
});

// ── Tool routes ──

router.get("/:projectId/benches/:id/tools", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const tools = toolService.getResolvedTools(req.params.projectId, benchId);
    res.json(tools);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.post("/:projectId/benches/:id/tools/:index/execute", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const index = parseIntParam(req.params.index, "tool index");
    const { userName } = (req.body ?? {}) as ExecuteToolRequest;
    const result = await toolService.executeTool(req.params.projectId, benchId, index, userName);
    if (!result.success) {
      res.status(400).json(result);
    } else {
      res.json(result);
    }
  } catch (err) {
    handleBenchError(res, err);
  }
});

// ── Notification routes ──

router.delete("/:projectId/benches/:id/notifications", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = benchManager.getBench(req.params.projectId, benchId);
    if (!bench) {
      res.status(404).json({ error: "Bench not found" });
      return;
    }
    notificationService.dismissBenchLevelForBench(bench);
    res.json(notificationService.getNotifications(bench));
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.delete("/:projectId/benches/:id/notifications/:notificationId", (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = benchManager.getBench(req.params.projectId, benchId);
    if (!bench) {
      res.status(404).json({ error: "Bench not found" });
      return;
    }
    notificationService.dismissOne(bench, req.params.notificationId);
    res.json(notificationService.getNotifications(bench));
  } catch (err) {
    handleBenchError(res, err);
  }
});

// ── Container assignment routes ──

router.post("/:projectId/benches/:id/assign-container", async (req, res) => {
  const { containerId, component } = req.body as AssignContainerRequest;

  if (!containerId || !component) {
    res.status(400).json({ error: "containerId and component are required" });
    return;
  }

  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = await benchManager.assignContainer(
      req.params.projectId,
      benchId,
      component,
      containerId,
    );
    res.json(bench);
  } catch (err) {
    handleBenchError(res, err);
  }
});

router.delete("/:projectId/benches/:id/assign-container/:component", async (req, res) => {
  try {
    const benchId = parseIntParam(req.params.id, "bench id");
    const bench = await benchManager.unassignContainer(
      req.params.projectId,
      benchId,
      req.params.component,
    );
    res.json(bench);
  } catch (err) {
    handleBenchError(res, err);
  }
});

export default router;
