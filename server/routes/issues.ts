import { Router, type Response } from "express";
import type {
  AssignIssueRequest,
  ListIssuesParams,
  NormalizedComment,
  NormalizedIssue,
  PaginatedIssues,
  PluginError,
} from "@roubo/shared";
import { resolveActivePlugin, type ActivePlugin } from "../services/active-plugin.js";
import * as pluginManager from "../services/plugin-manager.js";
import { ensurePluginActivated } from "../services/plugin-activation.js";
import * as issueAssignment from "../services/issue-assignment.js";
import { parseIntParam } from "./helpers.js";
import { ServiceError } from "../services/service-error.js";
import { sendGitHubErrorResponse } from "./github-error-handler.js";

const router = Router();

async function getActivePluginOrRespond(
  projectId: string,
  res: Response,
): Promise<ActivePlugin | null> {
  const active = resolveActivePlugin(projectId);
  if (!active) {
    res.status(503).json({
      error: "no-active-integration",
      message: "No integration plugin is configured for this project.",
    });
    return null;
  }
  // Push the project's current source selection to the plugin before the
  // caller invokes any source-bound RPC. Cached per (plugin, project,
  // config-hash) so steady-state cost is one Map lookup.
  try {
    await ensurePluginActivated(projectId, active.pluginId);
  } catch (err) {
    res.status(502).json({
      error: "plugin-activation-failed",
      message: (err as Error).message,
    });
    return null;
  }
  return active;
}

function sendPluginRpcError(res: Response, err: unknown): void {
  const pluginErr = err as Partial<PluginError> & { message?: string };
  const code = typeof pluginErr.code === "string" ? pluginErr.code : "rpc-error";
  const message = pluginErr.message ?? "Plugin call failed";
  const status =
    code === "plugin-not-enabled" || code === "unknown-plugin"
      ? 503
      : code === "timeout"
        ? 504
        : 502;
  res.status(status).json({ error: code, message });
}

router.get("/:projectId/issues", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  const requestCursor: string | null =
    typeof req.query.cursor === "string" && req.query.cursor.length > 0 ? req.query.cursor : null;

  let pageSize = active.pageSize;
  if (typeof req.query.pageSize === "string") {
    const n = parseInt(req.query.pageSize, 10);
    if (Number.isFinite(n) && n > 0) pageSize = n;
  }

  const filters: ListIssuesParams["filters"] = {};
  if (typeof req.query.labels === "string" && req.query.labels.length > 0) {
    filters.labels = req.query.labels
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (typeof req.query.search === "string" && req.query.search.length > 0) {
    filters.search = req.query.search;
  }

  const params: ListIssuesParams = {
    cursor: requestCursor,
    pageSize,
    filters: Object.keys(filters).length > 0 ? filters : undefined,
  };

  let raw: { items: NormalizedIssue[]; nextCursor: string | null };
  try {
    raw = await pluginManager.invoke<{ items: NormalizedIssue[]; nextCursor: string | null }>(
      active.pluginId,
      "listIssues",
      params,
    );
  } catch (err) {
    sendPluginRpcError(res, err);
    return;
  }

  // Per-request dedup keyed on (integrationId, externalId) (FR-020 / TC-023).
  const seen = new Set<string>();
  const deduped = raw.items.filter((item) => {
    const key = `${item.integrationId}::${item.externalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Stall detection (TC-071): host marks the page stalled when the plugin
  // echoes back the same cursor it was given. Per-page duplicate-collapse is
  // not a stall indicator because dedup always preserves the first occurrence,
  // so an N-item page of identical issues still yields one unique item.
  const stalled = raw.nextCursor !== null && raw.nextCursor === requestCursor;

  const body: PaginatedIssues = {
    items: deduped,
    nextCursor: stalled ? null : raw.nextCursor,
    stalled: stalled || undefined,
  };
  res.json(body);
});

router.get("/:projectId/issues/:externalId", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  try {
    const issue = await pluginManager.invoke<NormalizedIssue>(active.pluginId, "getIssue", {
      externalId: req.params.externalId,
    });
    res.json(issue);
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.post("/:projectId/issues/:externalId/transitions", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  const { transitionName } = (req.body ?? {}) as { transitionName?: unknown };
  if (typeof transitionName !== "string" || transitionName.length === 0) {
    res.status(400).json({ error: "transitionName is required and must be a non-empty string" });
    return;
  }

  try {
    const issue = await pluginManager.invoke<NormalizedIssue>(active.pluginId, "applyTransition", {
      externalId: req.params.externalId,
      transitionName,
    });
    res.json(issue);
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.post("/:projectId/issues/:externalId/assign", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  const { assigneeExternalId } = (req.body ?? {}) as { assigneeExternalId?: unknown };
  if (typeof assigneeExternalId !== "string" || assigneeExternalId.length === 0) {
    res
      .status(400)
      .json({ error: "assigneeExternalId is required and must be a non-empty string" });
    return;
  }

  try {
    await pluginManager.invoke(active.pluginId, "assignIssue", {
      externalId: req.params.externalId,
      assigneeExternalId,
    });
    res.status(204).end();
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.delete("/:projectId/issues/:externalId/assign", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  const { assigneeExternalId } = (req.body ?? {}) as { assigneeExternalId?: unknown };
  if (typeof assigneeExternalId !== "string" || assigneeExternalId.length === 0) {
    res
      .status(400)
      .json({ error: "assigneeExternalId is required and must be a non-empty string" });
    return;
  }

  try {
    await pluginManager.invoke(active.pluginId, "unassignIssue", {
      externalId: req.params.externalId,
      assigneeExternalId,
    });
    res.status(204).end();
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.get("/:projectId/issues/:externalId/comments", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  try {
    const comments = await pluginManager.invoke<NormalizedComment[]>(
      active.pluginId,
      "getComments",
      { externalId: req.params.externalId },
    );
    res.json(comments);
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.get("/:projectId/labels", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  try {
    const labels = await pluginManager.invoke<string[]>(active.pluginId, "listLabels", {});
    res.json(labels);
  } catch (err) {
    sendPluginRpcError(res, err);
  }
});

router.post("/:projectId/benches/:id/assign-issue", async (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.id, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }
  const { issueNumber } = req.body as AssignIssueRequest;

  if (!issueNumber || typeof issueNumber !== "number") {
    res.status(400).json({ error: "issueNumber is required and must be a number" });
    return;
  }

  try {
    const result = await issueAssignment.assignIssue(req.params.projectId, benchId, issueNumber);
    res.json(result);
  } catch (err) {
    if (err instanceof ServiceError) {
      res.status(err.statusCode).json({ ...err.data, error: err.message });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

router.delete("/:projectId/benches/:id/assign-issue", async (req, res) => {
  let benchId: number;
  try {
    benchId = parseIntParam(req.params.id, "bench id");
  } catch {
    res.status(400).json({ error: "Invalid bench id" });
    return;
  }

  try {
    const bench = await issueAssignment.unassignIssue(req.params.projectId, benchId);
    res.json(bench);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

export default router;
