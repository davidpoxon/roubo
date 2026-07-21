// Host-side translation of a gate's `tracker` block into the qualified
// externalId the bundled GitHub / GHE plugins key on (issue #1006).
//
// Per the work-units contract (`shared/work-units-contract.ts`, TrackerSchema),
// `tracker.ref` is a BARE tracker id: an issue number for GitHub / GHE, an issue
// key for Jira. The bundled GitHub plugins (`plugins/_shared-github/src/
// external-id.ts`, `parseGithubExternalId`) require a qualified `owner/repo#<n>`
// externalId and correctly reject a bare id. The host must therefore qualify a
// bare github/ghe ref with the `owner/repo` carried in `tracker.url` before
// invoking `getIssue` / `applyTransition`, rather than passing `tracker.ref`
// verbatim (which crashes with `[shared-github] externalId "1033" missing "#"`).
//
// This mirrors `alert-external-id.ts`: a minimal host-side helper so the host
// never has to import a plugin-internal package.

import type { Tracker } from "@roubo/shared/work-units-contract";

/**
 * Parse the `owner/repo` prefix from a GitHub / GHE issue url: the first two
 * non-empty path segments. Works for github.com
 * (`https://github.com/owner/repo/issues/1033` -> `owner/repo`) and a GHE host
 * alike (`https://ghe.host/owner/repo/issues/7` -> `owner/repo`). Returns null
 * when the url is unparseable or carries fewer than two path segments.
 */
export function repoFullNameFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return null;
  return `${segments[0]}/${segments[1]}`;
}

/**
 * Translate a gate's `tracker` block into the plugin externalId to pass to the
 * bundled GitHub / GHE plugin RPCs (`getIssue` / `applyTransition`).
 *
 * - Idempotent: a ref that already contains `#` is assumed already qualified
 *   (e.g. a pre-qualified `owner/repo#460` fixture, or an alert
 *   `owner/repo#code-scanning-5` ref) and is returned unchanged.
 * - Jira passthrough: the issue key IS the externalId, so `tracker.ref` is
 *   returned as-is.
 * - GitHub / GHE: the bare `tracker.ref` (an issue number) is qualified with the
 *   `owner/repo` parsed from `tracker.url`, yielding `owner/repo#<n>`.
 *
 * @throws when a github/ghe `tracker.url` cannot be parsed into an `owner/repo`.
 */
export function gateTrackerExternalId(tracker: Tracker): string {
  // Already qualified (a `#` means owner/repo#<n> or an alert form): pass through
  // so pre-qualified fixtures and alert refs are untouched (idempotent).
  if (tracker.ref.includes("#")) return tracker.ref;

  // A Jira issue key is already the externalId the plugin expects.
  if (tracker.system === "jira") return tracker.ref;

  const repoFullName = repoFullNameFromUrl(tracker.url);
  if (repoFullName === null) {
    throw new Error(
      `Cannot qualify tracker ref "${tracker.ref}": tracker url "${tracker.url}" has no "owner/repo" path segment.`,
    );
  }
  return `${repoFullName}#${tracker.ref}`;
}
