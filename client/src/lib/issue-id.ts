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

const ALERT_EXTERNAL_ID_RE = /#(code-scanning|secret-scanning|dependabot)-\d+$/;

/**
 * True when an externalId is a GitHub security alert (`owner/repo#<category>-<n>`).
 * Such issues have no bare numeric form, so bench creation assigns them by
 * externalId rather than issueNumber.
 */
export function isAlertExternalId(externalId: string): boolean {
  return ALERT_EXTERNAL_ID_RE.test(externalId);
}

/**
 * Short, human-facing id for a pending/assigned issue, derived from its
 * externalId: the part after `#` (e.g. `42` or `code-scanning-117`), or the
 * whole value when there is no `#`.
 */
export function shortIdFromExternalId(externalId: string): string {
  return externalId.includes("#") ? (externalId.split("#").pop() ?? externalId) : externalId;
}

/**
 * Display label for an assigned issue. GitHub issues and alerts have a numeric
 * `number` and render as `#42` / `#117`; integrations without one (e.g. Jira)
 * render the externalId key as-is (`PLNRPTGOOG-3782`).
 */
export function displayIssueRef(assignedIssue: { number?: number; externalId: string }): string {
  return assignedIssue.number != null ? `#${assignedIssue.number}` : assignedIssue.externalId;
}
