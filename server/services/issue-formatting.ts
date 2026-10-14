import type { AssignedIssue, NormalizedComment, NormalizedIssue } from "@roubo/shared";
import { resolveActivePlugin } from "./active-plugin.js";
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

  const { externalId } = assignedIssue;
  const active = resolveActivePlugin(projectId);
  if (!active || active.pluginId !== assignedIssue.integrationId) {
    return buildPersistedIssueContext(assignedIssue);
  }

  let issue: NormalizedIssue;
  try {
    await ensurePluginActivated(projectId, active.pluginId);
    issue = await pluginManager.invoke<NormalizedIssue>(active.pluginId, "getIssue", {
      externalId,
    });
  } catch (err) {
    console.warn(
      `[issue-context] Failed to fetch ${externalId} for jig context, using persisted data: ${(err as Error).message}`,
    );
    return buildPersistedIssueContext(assignedIssue);
  }

  let comments: NormalizedComment[] = [];
  try {
    comments = await pluginManager.invoke<NormalizedComment[]>(active.pluginId, "getComments", {
      externalId,
    });
  } catch (err) {
    console.warn(
      `[issue-context] Failed to fetch comments for ${externalId}: ${(err as Error).message}`,
    );
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
