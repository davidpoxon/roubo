import { Router } from "express";
import * as githubService from "../services/github.js";
import type { BlockingRelationshipsResult } from "../services/github.js";
import * as issueAssignment from "../services/issue-assignment.js";
import * as projectRegistry from "../services/project-registry.js";
import { loadSettings } from "../services/state.js";
import { parseIntParam } from "./helpers.js";
import { ServiceError } from "../services/service-error.js";
import { sendGitHubErrorResponse } from "./github-error-handler.js";
import type { AssignIssueRequest } from "@roubo/shared";

const router = Router();

function getRepoFullName(projectId: string): string | null {
  const project = projectRegistry.getProject(projectId);
  return project?.config?.project?.repo ?? null;
}

async function fetchBlockers(
  repo: string,
  issueNumbers: number[],
): Promise<BlockingRelationshipsResult | null> {
  if (!loadSettings().benches?.enforceIssueDependencies || issueNumbers.length === 0) return null;
  return githubService.fetchBlockingRelationships(repo, issueNumbers);
}

router.get("/:projectId/issues", async (req, res) => {
  const repo = getRepoFullName(req.params.projectId);
  if (!repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }

  const labels = req.query.labels as string | undefined;
  const search = req.query.search as string | undefined;

  try {
    const issues = await githubService.fetchIssues(repo, { labels, search });
    // blockingCount is intentionally omitted here — the /issues endpoint is used by
    // the bench assignment flow, not the Cut List panel which shows the blocking badge.
    const blocking = await fetchBlockers(
      repo,
      issues.map((i) => i.number),
    );
    res.json(
      blocking
        ? issues.map((issue) => ({ ...issue, blockedBy: blocking.blockedBy[issue.number] ?? [] }))
        : issues,
    );
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.get("/:projectId/issues/:number", async (req, res) => {
  const repo = getRepoFullName(req.params.projectId);
  if (!repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }

  let issueNumber: number;
  try {
    issueNumber = parseIntParam(req.params.number, "issue number");
  } catch {
    res.status(400).json({ error: "Invalid issue number" });
    return;
  }

  try {
    const issue = await githubService.fetchIssueDetail(repo, issueNumber);
    res.json(issue);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.get("/:projectId/issues/:number/comments", async (req, res) => {
  const repo = getRepoFullName(req.params.projectId);
  if (!repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }

  let issueNumber: number;
  try {
    issueNumber = parseIntParam(req.params.number, "issue number");
  } catch {
    res.status(400).json({ error: "Invalid issue number" });
    return;
  }

  try {
    const comments = await githubService.fetchIssueComments(repo, issueNumber);
    res.json(comments);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.get("/:projectId/labels", async (req, res) => {
  const repo = getRepoFullName(req.params.projectId);
  if (!repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }

  try {
    const labels = await githubService.fetchLabels(repo);
    res.json(labels);
  } catch (err) {
    sendGitHubErrorResponse(res, err);
  }
});

router.get("/:projectId/project-items", async (req, res) => {
  const repo = getRepoFullName(req.params.projectId);
  if (!repo) {
    res.status(404).json({ error: "Project not found or has no repo configured" });
    return;
  }

  let projectNumber: number;
  try {
    projectNumber = parseIntParam(req.query.project as string, "project");
  } catch {
    res.status(400).json({ error: "project query parameter is required and must be a number" });
    return;
  }

  try {
    const result = await githubService.fetchProjectItems(repo, projectNumber);
    const blocking = await fetchBlockers(
      repo,
      result.items.map((i) => i.issue.number),
    );
    res.json({
      ...result,
      items: blocking
        ? result.items.map((item) => ({
            ...item,
            issue: {
              ...item.issue,
              blockedBy: blocking.blockedBy[item.issue.number] ?? [],
              blockingCount: blocking.blockingCount[item.issue.number] ?? 0,
            },
          }))
        : result.items,
    });
  } catch (err) {
    sendGitHubErrorResponse(res, err);
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
