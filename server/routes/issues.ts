import { Router } from "express";
import type {
  AssignIssueRequest,
  ListIssuesParams,
  NormalizedComment,
  NormalizedIssue,
  PaginatedIssues,
} from "@roubo/shared";
import * as pluginManager from "../services/plugin-manager.js";
import { awaitPendingIntegrationSetup } from "../services/integration-migrations.js";
import { resolveSources } from "../services/plugin-activation.js";
import * as issueAssignment from "../services/issue-assignment.js";
import { getSnapshot, recordSnapshot } from "../services/issue-snapshot-cache.js";
import { cutListQueryService } from "../services/cut-list-query-service.js";
import { parseIntParam } from "./helpers.js";
import { getActivePluginOrRespond, fetchPluginComments } from "./plugin-route-helpers.js";
import { ServiceError } from "../services/service-error.js";
import { sendGitHubErrorResponse } from "./github-error-handler.js";
import { sendPluginRpcError } from "./plugin-rpc-error.js";

const router = Router();

router.get("/:projectId/issues", async (req, res) => {
  const active = await getActivePluginOrRespond(req.params.projectId, res);
  if (!active) return;

  // Parse the query string. The cache, parameter, dedup, and stall logic all
  // live in CutListQueryService; the route only parses, delegates, serialises.
  const cursor: string | null =
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

  const isFirstPage = cursor === null;
  const queryInput = { cursor, pageSize, filters };

  try {
    await awaitPendingIntegrationSetup(req.params.projectId);
    const result = await cutListQueryService.queryFirstOrPage(
      req.params.projectId,
      active,
      queryInput,
    );
    const body: PaginatedIssues = {
      items: result.items,
      nextCursor: result.nextCursor,
      stalled: result.stalled,
    };
    if (result.warnings) body.warnings = result.warnings;
    if (typeof result.excludedCount === "number") body.excludedCount = result.excludedCount;
    // Stale-while-revalidate signal (FR-002): surface the cache-state and, when
    // the warm snapshot was served, its capture timestamp so the client can
    // drive the warm / revalidating indicator. First-page-only: the disk cache
    // is first-page-only, so the signal is meaningful only there; paginated
    // (cursor > 0) responses omit it, matching the PaginatedIssues.cacheStatus
    // contract.
    if (isFirstPage) {
      body.cacheStatus = result.cacheStatus;
      if (result.snapshotCapturedAt) body.snapshotCapturedAt = result.snapshotCapturedAt;
    }
    // FR-014: keep capturing every successful first-page response into the
    // in-memory snapshot cache so the errored/disabled fallback above has
    // something to serve. The persistent disk cache does not supersede this
    // in-memory fallback in this slice; the behaviour here is unchanged.
    if (isFirstPage) {
      const params = cutListQueryService.buildListParams(req.params.projectId, queryInput);
      const pluginName =
        pluginManager.getRecord(active.pluginId)?.manifest?.name ?? active.pluginId;
      recordSnapshot(active.pluginId, req.params.projectId, params, body, pluginName, true);
    }
    res.json(body);
  } catch (err) {
    // FR-014: when the active plugin is `errored` or `disabled` and we have a
    // first-page snapshot from a previous successful call, serve it so the
    // cut-list keeps rendering instead of going blank. `stale: true` lets the
    // client surface the matching banner (#263 tracks the UI work). We only
    // bridge first-page requests because the snapshot captures only the first
    // page; falling through on cursor > 0 keeps the client from looking up an
    // arbitrarily-stale tail page that no longer matches the first page. This
    // in-memory fallback is unchanged: the persistent disk cache (this slice)
    // does not yet supersede it.
    const record = pluginManager.getRecord(active.pluginId);
    if (isFirstPage && (record?.status === "errored" || record?.status === "disabled")) {
      const params = cutListQueryService.buildListParams(req.params.projectId, queryInput);
      const cached = getSnapshot(active.pluginId, req.params.projectId, params);
      if (cached) {
        const stale: PaginatedIssues = {
          ...cached.response,
          stale: true,
          snapshotCapturedAt: cached.capturedAt,
        };
        // NFR-009: log the stale serve so a degraded cut list is diagnosable.
        // Carries only cache-state and identity (plugin, project, plugin
        // status, snapshot age), never issue content, credentials, or tokens.
        console.warn(
          `[cut-list-cache] stale-serve plugin=${active.pluginId} project=${req.params.projectId} status=${record?.status} capturedAt=${cached.capturedAt}`,
        );
        res.json(stale);
        return;
      }
    }
    sendPluginRpcError(res, err);
  }
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
  const { externalId } = req.body as AssignIssueRequest;

  if (!externalId || typeof externalId !== "string") {
    res.status(400).json({ error: "externalId is required and must be a string" });
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

  const comments = await fetchPluginComments(active.pluginId, externalId);

  try {
    const result = await issueAssignment.assignIssue(
      req.params.projectId,
      benchId,
      issue,
      comments,
    );
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
