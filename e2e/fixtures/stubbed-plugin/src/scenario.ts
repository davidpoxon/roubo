import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConnectionStatus,
  CurrentUser,
  FilterFacet,
  FilterFacetOption,
  IssueTypeOption,
  ListIssuesWarning,
  NormalizedComment,
  NormalizedIssue,
  SourceCandidatesResponse,
} from "@roubo/plugin-sdk";

export interface ScenarioFacetOptions {
  [facetId: string]: FilterFacetOption[];
}

export interface Scenario {
  pluginId: string;
  currentUser: CurrentUser;
  connectionStatus: ConnectionStatus;
  // WU-064: when present, `getConnectionStatus` returns the i-th entry on the
  // i-th call (and clamps to the last entry thereafter). Lets TC-169 model
  // "connected on first call, auth-problem on next call" without restarting
  // the stub process.
  connectionStatusSequence?: ConnectionStatus[];
  sourceCandidates: SourceCandidatesResponse;
  issues: NormalizedIssue[];
  // WU-069: per-call warnings returned alongside the static `issues` page.
  // When `listIssuesSequence` is set, this field is ignored.
  listIssuesWarnings?: ListIssuesWarning[];
  // WU-069: when present, each `listIssues` call walks the i-th entry and
  // clamps at the last. Mirrors the connection-status pattern so TC-180 can
  // model "401 warning on first pull, Dependabot rows on the next" without
  // restarting the stub process.
  listIssuesSequence?: Array<{
    items: NormalizedIssue[];
    warnings?: ListIssuesWarning[];
  }>;
  commentsByExternalId: Record<string, NormalizedComment[]>;
  issueTypes: IssueTypeOption[];
  labels: string[];
  facets: FilterFacet[];
  facetOptions: ScenarioFacetOptions;
  // WU-067 (TC-175): when true, the contract omits `filterFacets` and
  // `getFacetOptions` so the host's RPC layer rejects with MethodNotFound,
  // which `plugin-filter-facets.ts` maps to `COMMON_FACET_FALLBACK`. Models a
  // plugin built against host-API 1.0.0.
  omitFilterFacets?: boolean;
  // WU-066 (TC-172): when true, the stub exits non-zero before opening the
  // RPC channel so plugin-manager.spawnPlugin() surfaces an `rpc-init-failed`
  // entry. Drives the "plugin refuses to start" arm of the Enable-prompt
  // failure spec.
  failOnStart?: boolean;
}

const SCENARIOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scenarios");

export function loadScenario(name: string): Scenario {
  const file = path.join(SCENARIOS_DIR, `${name}.json`);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Unknown scenario "${name}": ${file} not found.`, { cause: err });
    }
    throw err;
  }
  const parsed = JSON.parse(raw) as Scenario;
  return Object.freeze(parsed);
}
