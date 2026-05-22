import type { NormalizedIssue } from "@roubo/plugin-sdk";
import { parseExternalId, formatExternalId } from "../external-id.js";
import { fetchBlockingRelationships, fetchIssueDetail } from "../github-fetchers.js";
import { rawToNormalizedIssue } from "../normalize.js";

export async function getIssue(params: { externalId: string }): Promise<NormalizedIssue> {
  const { repoFullName, issueNumber } = parseExternalId(params.externalId);
  const raw = await fetchIssueDetail(repoFullName, issueNumber);
  const blocking = await fetchBlockingRelationships(repoFullName, [issueNumber]);

  const issue = rawToNormalizedIssue(raw, {
    blockedBy: (blocking.blockedBy[issueNumber] ?? []).map((b) =>
      formatExternalId(repoFullName, b.number),
    ),
    blocks: (blocking.blocks[issueNumber] ?? []).map((b) =>
      formatExternalId(repoFullName, b.number),
    ),
  });
  issue.externalId = formatExternalId(repoFullName, issueNumber);
  return issue;
}
