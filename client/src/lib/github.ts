/**
 * Derive the URL for a specific issue in the same repo as a reference issue.
 * Strips /issues/<n> from the reference URL and appends the target issue number.
 */
export function blockerUrl(issueHtmlUrl: string, blockerNumber: number): string {
  const base = issueHtmlUrl.replace(/\/issues\/\d+$/, "");
  return `${base}/issues/${blockerNumber}`;
}
