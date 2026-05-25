import type { ConfiguredSource } from "@roubo/plugin-sdk";

// Optional per-source alert-category opt-ins (FR-074). Absent ⇒ false at the
// host layer; not yet surfaced across the plugin SDK boundary (`ConfiguredSource`
// is unchanged), so they appear only on entries returned by `parseSourcesConfig`.
export interface GithubSourceAlertFlags {
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

export type GithubSource =
  | ({ kind: "repo"; externalId: string } & GithubSourceAlertFlags)
  | ({ kind: "project"; externalId: string } & GithubSourceAlertFlags);

function isGithubSource(s: ConfiguredSource): s is GithubSource {
  return (s.kind === "repo" || s.kind === "project") && typeof s.externalId === "string";
}

/**
 * Return the first source from the host-supplied list, narrowed to the kinds
 * this plugin understands. Throws if the list is empty or shaped wrong; the
 * host is expected to only invoke source-bound methods when sources are
 * configured.
 */
export function requirePrimarySource(sources: ConfiguredSource[] | undefined): GithubSource {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "[github-com] sources is required for source-bound methods (listIssues, listIssueTypes, listLabels).",
    );
  }
  const first = sources[0];
  if (!isGithubSource(first)) {
    throw new Error(
      `[github-com] unsupported source kind "${first?.kind}"; expected "repo" or "project".`,
    );
  }
  return first;
}
