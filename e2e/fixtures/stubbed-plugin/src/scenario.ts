import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConnectionStatus,
  CurrentUser,
  FilterFacet,
  FilterFacetOption,
  IssueTypeOption,
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
