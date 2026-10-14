import type { AssignedIssue, NormalizedComment, NormalizedIssue } from "@roubo/shared";
import { resolveActivePlugin } from "./active-plugin.js";
import * as projectRegistry from "./project-registry.js";
import { ensurePluginActivated } from "./plugin-activation.js";
import * as pluginManager from "./plugin-manager.js";
import { isAlertExternalId } from "./alert-external-id.js";
import { buildAlertIssueContext } from "./alert-formatting.js";

export interface IssueContext {
  // Absent for integrations whose issues have no numeric form (e.g. Jira); those
  // carry `issueKey` instead. GitHub issues and alerts set `issueNumber`.
  issueNumber?: number;
  // Human-facing issue identifier (the externalId) for non-GitHub integrations,
  // surfaced to jigs as {{issueKey}}.
  issueKey?: string;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  comments: string;
}

/**
 * Build jig issue context from the persisted bench state alone, without any
 * network call: the title, identifier and URL the bench was assigned with.
 * GitHub issues and alerts keep `issueNumber`; issues with no numeric form
 * (e.g. a Jira key) carry the externalId as `issueKey`.
 */
export function buildPersistedIssueContext(
  assignedIssue: Pick<AssignedIssue, "number" | "externalId" | "title" | "externalUrl">,
): Partial<IssueContext> {
  if (assignedIssue.number != null) {
    return {
      issueNumber: assignedIssue.number,
      issueTitle: assignedIssue.title,
      ...(assignedIssue.externalUrl ? { issueUrl: assignedIssue.externalUrl } : {}),
    };
  }
  return {
    issueKey: assignedIssue.externalId,
    issueTitle: assignedIssue.title,
    issueBody: "",
    issueUrl: assignedIssue.externalUrl ?? "",
    comments: "",
  };
}

/**
 * The externalId to fetch an assigned issue by. A pre-plugin bench carries
 * `integrationId: "github-com"` and `externalId: String(number)` (see
 * `migrateAssignedIssue`), which the GitHub plugins reject because it names no
 * repo. Those benches were assigned from the project's own repo, so qualify
 * the bare number with it.
 */
export function assignedIssueFetchId(projectId: string, assignedIssue: AssignedIssue): string {
  const { externalId, number, integrationId } = assignedIssue;
  if (integrationId !== "github-com" || number == null || externalId !== String(number)) {
    return externalId;
  }
  const repo = projectRegistry.getProject(projectId)?.config?.project?.repo;
  return repo ? `${repo}#${number}` : externalId;
}

/**
 * Build jig issue context for a bench's assigned issue. Alerts re-hydrate from
 * the persisted redacted raw. Every other issue is fetched through the
 * project's active integration plugin by its own externalId, so an issue from
 * a submodule or another source repo resolves against that repo, not the
 * project's root repo. When there is no active plugin, the active plugin is
 * not the one the issue came from, or `getIssue` fails, the context falls back
 * to the persisted state. A `getComments` failure only drops the comments.
 */
export async function resolveAssignedIssueContext(
  projectId: string,
  assignedIssue: AssignedIssue,
): Promise<Partial<IssueContext>> {
  if (isAlertExternalId(assignedIssue.externalId)) return buildAlertIssueContext(assignedIssue);

  const active = resolveActivePlugin(projectId);
  if (!active || active.pluginId !== assignedIssue.integrationId) {
    return buildPersistedIssueContext(assignedIssue);
  }
  const externalId = assignedIssueFetchId(projectId, assignedIssue);

  let issue: NormalizedIssue;
  let comments: NormalizedComment[] = [];
  try {
    await ensurePluginActivated(projectId, active.pluginId);
    // Fetched together so a slow tracker costs one round trip, not two.
    const [issueResult, commentsResult] = await Promise.allSettled([
      pluginManager.invoke<NormalizedIssue>(active.pluginId, "getIssue", { externalId }),
      pluginManager.invoke<NormalizedComment[]>(active.pluginId, "getComments", { externalId }),
    ]);
    if (issueResult.status === "rejected") throw issueResult.reason;
    issue = issueResult.value;
    if (commentsResult.status === "fulfilled") {
      comments = commentsResult.value;
    } else {
      console.warn(
        `[issue-context] Failed to fetch comments for ${externalId}: ${(commentsResult.reason as Error).message}`,
      );
    }
  } catch (err) {
    console.warn(
      `[issue-context] Failed to fetch ${externalId} for jig context, using persisted data: ${(err as Error).message}`,
    );
    return buildPersistedIssueContext(assignedIssue);
  }

  return {
    ...(assignedIssue.number != null
      ? { issueNumber: assignedIssue.number }
      : { issueKey: externalId }),
    issueTitle: issue.title,
    issueBody: formatIssueBody(issue.body),
    issueUrl: issue.externalUrl,
    comments: formatComments(comments.map((c) => ({ user: c.author.displayName, body: c.body }))),
  };
}

export function formatIssueBody(body: string | null): string {
  if (!body) return "";
  return body.length > 10000 ? body.slice(0, 10000) + "\n\n[truncated]" : body;
}

export function formatComments(comments: Array<{ user: string; body: string }>): string {
  if (comments.length === 0) return "";
  const maxComments = 50;
  const recent = comments.slice(-maxComments);
  let result =
    comments.length > maxComments
      ? `## Comments (showing last ${maxComments} of ${comments.length})\n`
      : "## Comments\n";
  for (const comment of recent) {
    result += `\n**${comment.user}:**\n${comment.body}\n`;
  }
  return result;
}
