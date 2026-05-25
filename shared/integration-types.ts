/**
 * Declarative source-picker payloads returned by an integration plugin's
 * `listSourceCandidates` RPC. Roubo's host renders the UI; plugins ship no
 * React. See `.specifications/integration-plugins/architecture.md` (FR-019).
 */

export type SourceCandidateIcon = "repo" | "project" | "board" | "epic" | "filter";

export interface SourceCandidateItem {
  externalId: string;
  label: string;
  sublabel?: string;
  icon?: SourceCandidateIcon;
}

export interface SourceCandidateCategory {
  id: string;
  label: string;
  items: SourceCandidateItem[];
}

export type SourceCandidatesShape = "multi-list" | "categorized-multi-list";

export interface SourceCandidatesResponse {
  shape: SourceCandidatesShape;
  // Present iff shape === "multi-list".
  items?: SourceCandidateItem[];
  // Present iff shape === "categorized-multi-list".
  categories?: SourceCandidateCategory[];
  // Reserved for future pagination; v1 plugins return undefined.
  nextCursor?: string | null;
}

/**
 * One persisted source entry. The primitive `string` form is the externalId;
 * the object form carries per-source toggles (currently only the GitHub-family
 * Code Scanning / Secret Scanning / Dependabot booleans, ignored by other
 * plugins). The two forms are interchangeable on disk: a writer collapses to
 * the primitive form when no toggles are set, and expands to the object form
 * the moment any toggle turns on.
 */
export type SourceSelectionEntry =
  | string
  | {
      externalId: string;
      includeCodeQLAlerts?: boolean;
      includeSecretScanningAlerts?: boolean;
      includeDependabotAlerts?: boolean;
    };

/**
 * Persisted selection for a project. Keys are plugin-defined category ids
 * (or the literal `"items"` for the multi-list shape). Values are arrays of
 * source entries (string externalIds or objects with per-source toggles).
 * Stored verbatim in `integration.sources` of the per-user override and
 * treated as opaque-to-Roubo elsewhere.
 */
export type SourceSelection = Record<string, SourceSelectionEntry[]>;
