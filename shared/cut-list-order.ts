// Unblocked-first cut-list ordering (#653, #844).
//
// Platform-agnostic and pure: no fs, no node builtins, no React. Safe in both
// the Vite client build and the Express server. It lives in `shared/` because
// two layers apply it: the server materialises the whole result set and orders
// it once before slicing host-owned pages (#844), and the client re-applies it
// after its own filtering and grouping so the order survives those passes.

import type { NormalizedIssue } from "./types";

/**
 * Partition cut-list items so unblocked items render before blocked ones.
 *
 * `NormalizedIssue.blockedBy` lists the external ids this item is blocked by; an
 * empty array means nothing blocks it. Regardless of the requested sort, all
 * unblocked items should appear first (in the requested order) followed by all
 * blocked items (in the requested order). This is a stable partition: it splits
 * the already-sorted input into two buckets without reordering within either, so
 * the caller's sort is preserved inside each partition.
 *
 * Applying it twice is a no-op, so the client can re-apply it to an
 * already-ordered server page after filtering without disturbing the order.
 * Apply it before grouping so the unblocked-first order also holds within each
 * group (`groupItems` buckets in input order).
 *
 * The authoritative application is server-side, over the whole materialised
 * result set rather than a single page, so the ordering holds across every page
 * of the paged sequence (#844).
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
