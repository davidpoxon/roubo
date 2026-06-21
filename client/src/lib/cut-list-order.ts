import type { NormalizedIssue } from "@roubo/shared";

/**
 * Partition cut-list items so unblocked items render before blocked ones (#653).
 *
 * `NormalizedIssue.blockedBy` lists the external ids this item is blocked by; an
 * empty array means nothing blocks it. Regardless of the requested sort, all
 * unblocked items should appear first (in the requested order) followed by all
 * blocked items (in the requested order). This is a stable partition: it splits
 * the already-sorted input into two buckets without reordering within either, so
 * the caller's sort is preserved inside each partition.
 *
 * Apply this before grouping so the unblocked-first order also holds within each
 * group (`groupItems` buckets in input order). Under pagination this reorders
 * within the loaded page only; cross-page unblocked-first ordering would require
 * server-side support (out of scope for this slice, see #653).
 */
export function partitionUnblockedFirst(issues: NormalizedIssue[]): NormalizedIssue[] {
  const unblocked: NormalizedIssue[] = [];
  const blocked: NormalizedIssue[] = [];
  for (const issue of issues) {
    if (issue.blockedBy.length === 0) unblocked.push(issue);
    else blocked.push(issue);
  }
  return [...unblocked, ...blocked];
}
