import { Router } from "express";
import type {
  AssignIssueRequest,
  ListIssuesParams,
  ListIssuesWarning,
  NormalizedComment,
  NormalizedIssue,
  PaginatedIssues,
} from "@roubo/shared";
import * as pluginManager from "../services/plugin-manager.js";
import { resolveSources, resolveExclusion } from "../services/plugin-activation.js";
import { awaitPendingIntegrationSetup } from "../services/integration-migrations.js";
import * as issueAssignment from "../services/issue-assignment.js";
import { getSnapshot, recordSnapshot } from "../services/issue-snapshot-cache.js";
import { parseIntParam } from "./helpers.js";
import { getActivePluginOrRespond } from "./plugin-route-helpers.js";
import { ServiceError } from "../services/service-error.js";
import { sendGitHubErrorResponse } from "./github-error-handler.js";
import { sendPluginRpcError } from "./plugin-rpc-error.js";

const router = Router();

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

  const isFirstPage = requestCursor === null;
  let raw: {
    items: NormalizedIssue[];
    nextCursor: string | null;
    warnings?: ListIssuesWarning[];
    excludedCount?: number;
  };
  let params: ListIssuesParams | undefined;
  try {
    await awaitPendingIntegrationSetup(req.params.projectId);
    const exclusion = resolveExclusion(req.params.projectId);
    params = {
      sources: resolveSources(req.params.projectId),
      cursor: requestCursor,
      pageSize,
      filters: Object.keys(filters).length > 0 ? filters : undefined,
      excludedStatusCategories: exclusion.excludedStatusCategories,
      excludedStatuses: exclusion.excludedStatuses,
    };
    raw = await pluginManager.invoke<{
      items: NormalizedIssue[];
      nextCursor: string | null;
      warnings?: ListIssuesWarning[];
      excludedCount?: number;
    }>(active.pluginId, "listIssues", params);
  } catch (err) {
    // FR-014: when the active plugin is `errored` or `disabled` and we have a
    // first-page snapshot from a previous successful call, serve it so the
    // cut-list keeps rendering instead of going blank. `stale: true` lets the
    // client surface the matching banner (#263 tracks the UI work). We only
    // bridge first-page requests because the snapshot captures only the first
    // page; falling through on cursor > 0 keeps the client from looking up an
    // arbitrarily-stale tail page that no longer matches the first page.
    const record = pluginManager.getRecord(active.pluginId);
    if (params && isFirstPage && (record?.status === "errored" || record?.status === "disabled")) {
      const cached = getSnapshot(active.pluginId, req.params.projectId, params);
      if (cached) {
        const stale: PaginatedIssues = {
          ...cached.response,
          stale: true,
          snapshotCapturedAt: cached.capturedAt,
        };
        res.json(stale);
        return;
      }
    }
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
  if (raw.warnings && raw.warnings.length > 0) {
    body.warnings = raw.warnings;
  }
  // Pass through the plugin's in-query excluded count (FR-009/FR-010) so the
  // cut list can show how many issues the query dropped. Undefined-safe: a
  // plugin that can't cheaply count simply omits it.
  if (typeof raw.excludedCount === "number") {
    body.excludedCount = raw.excludedCount;
  }
  // FR-014: capture every successful first-page response so the errored /
  // disabled fallback above has something to serve. The cache normalizes the
  // snapshot (strips any stale markers) on insert so subsequent reads start
  // clean.
  if (isFirstPage) {
    const pluginName = pluginManager.getRecord(active.pluginId)?.manifest?.name ?? active.pluginId;
    recordSnapshot(active.pluginId, req.params.projectId, params, body, pluginName, true);
  }
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
    await awaitPendingIntegrationSetup(req.params.projectId);
    const labels = await pluginManager.invoke<string[]>(active.pluginId, "listLabels", {
      sources: resolveSources(req.params.projectId),
    });
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
