/**
 * Extract a GitHub-style issue number from a NormalizedIssue.externalId.
 *
 * The bench-assignment API (server/routes/issues.ts → assign-issue) still
 * takes `issueNumber: number` because the bench state shape is unchanged
 * by WU-016 (deferred to a follow-up WU). For the github-com plugin the
 * externalId is expected in `<owner>/<repo>#<number>` or `<repo>#<number>`
 * form; we extract the trailing number. Returns `null` when the format
 * doesn't match (e.g. a Jira-style key like `ROUBO-42`), in which case
 * callers should treat the issue as not assignable from the UI until the
 * bench-state migration ships.
 */
export function issueNumberFromExternalId(externalId: string): number | null {
  const after = externalId.includes("#") ? externalId.split("#").pop() : externalId;
  if (!after) return null;
  const n = parseInt(after, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== after) return null;
  return n;
}
