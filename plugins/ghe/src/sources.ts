import type { ConfiguredSource } from "@roubo/plugin-sdk";

export type GheSource =
  | { kind: "repo"; externalId: string }
  | { kind: "project"; externalId: string };

function isGheSource(s: ConfiguredSource): s is GheSource {
  return (s.kind === "repo" || s.kind === "project") && typeof s.externalId === "string";
}

/**
 * Return the first source from the host-supplied list, narrowed to the kinds
 * this plugin understands. Throws if the list is empty or shaped wrong; the
 * host is expected to only invoke source-bound methods when sources are
 * configured.
 */
export function requirePrimarySource(sources: ConfiguredSource[] | undefined): GheSource {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "[ghe] sources is required for source-bound methods (listIssues, listIssueTypes, listLabels).",
    );
  }
  const first = sources[0];
  if (!isGheSource(first)) {
    throw new Error(
      `[ghe] unsupported source kind "${first?.kind}"; expected "repo" or "project".`,
    );
  }
  return first;
}
