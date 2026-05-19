import * as githubService from "./github.js";

export interface IssueContext {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  comments: string;
}

export async function fetchIssueContext(repo: string, issueNumber: number): Promise<IssueContext> {
  const [issue, comments] = await Promise.all([
    githubService.fetchIssueDetail(repo, issueNumber),
    githubService.fetchIssueComments(repo, issueNumber),
  ]);
  return {
    issueNumber: issue.number,
    issueTitle: issue.title,
    issueBody: formatIssueBody(issue.body),
    issueUrl: issue.htmlUrl,
    comments: formatComments(comments),
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
