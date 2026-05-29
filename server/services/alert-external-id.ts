// Host-side recognition of the bundled GitHub plugins' alert externalId form,
// `<owner>/<repo>#<category>-<positive-int>` (e.g. `owner/repo#code-scanning-117`).
// The plugin owns the canonical parser (`@roubo/shared-github`); the host keeps
// its own minimal copy so it never has to import a plugin-internal package. The
// category prefix guarantees an alert id can never collide with a plain issue
// number on the same repo.

export const ALERT_CATEGORIES = ["code-scanning", "secret-scanning", "dependabot"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

const ALERT_EXTERNAL_ID_RE = /#(code-scanning|secret-scanning|dependabot)-(\d+)$/;

export interface ParsedAlertExternalId {
  category: AlertCategory;
  alertNumber: number;
}

/** Parses an alert externalId, or returns null for a plain-issue / non-GitHub id. */
export function parseAlertExternalId(externalId: string): ParsedAlertExternalId | null {
  const match = ALERT_EXTERNAL_ID_RE.exec(externalId);
  if (!match) return null;
  const alertNumber = Number(match[2]);
  if (!Number.isInteger(alertNumber) || alertNumber <= 0) return null;
  return { category: match[1] as AlertCategory, alertNumber };
}

/**
 * True when an assigned issue is backed by a security alert. Such benches have
 * no GitHub issue to re-fetch by number, so number-based code paths (auto-clear,
 * issue-state fallbacks) must skip them.
 */
export function isAlertExternalId(externalId: string | null | undefined): boolean {
  return externalId != null && parseAlertExternalId(externalId) !== null;
}
